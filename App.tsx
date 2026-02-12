
import React, { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';
import { decode, encode, decodeAudioData } from './utils/audioHelpers';
import { ConnectionStatus } from './types';

// Constants
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const SYSTEM_INSTRUCTION = `You are a world-class Socratic tutor. 
Your goal is to help the user learn by asking guiding questions.
You are looking through their smartphone camera. 

CRITICAL BEHAVIOR:
1. Visual Awareness: Observe what the user is pointing their camera at.
2. Socratic Method: Do NOT give answers. Ask leading questions. 
3. Brief & Human: Keep responses very short (1-2 sentences) and conversational.
4. Voice-First: Sound natural and encouraging.`;

const FRAME_RATE = 1; 
const JPEG_QUALITY = 0.5;

interface RecordedSession {
  id: string;
  blob: globalThis.Blob;
  timestamp: number;
  url: string;
}

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<RecordedSession[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [isFullRecordingSupported, setIsFullRecordingSupported] = useState(true);

  // Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Recording & Routing Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<globalThis.Blob[]>([]);
  const recordingMixerRef = useRef<GainNode | null>(null);

  const stopSession = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }

    if (sessionRef.current) {
      sessionRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }

    audioSourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    audioSourcesRef.current.clear();

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setStatus('disconnected');
  }, []);

  const startSession = async () => {
    try {
      setStatus('connecting');
      setError(null);
      setShowHistory(false);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

      // 1. Initialize Unified AudioContext (Standard 44.1kHz for iOS stability)
      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx({ sampleRate: 44100 });
      if (ctx.state === 'suspended') await ctx.resume();
      audioContextRef.current = ctx;

      // 2. Request Camera and Microphone
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }, 
        video: { facingMode: 'environment' } 
      });
      mediaStreamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      // 3. Setup Recording Graph with Fallback logic for iPadOS
      let combinedStream: MediaStream;
      let recorderDestNode: MediaStreamAudioDestinationNode | null = null;
      
      try {
        // Try creating the destination node
        if (typeof ctx.createMediaStreamAudioDestination === 'function') {
          recorderDestNode = ctx.createMediaStreamAudioDestination();
        } else {
          // Fallback to constructor
          recorderDestNode = new (window as any).MediaStreamAudioDestinationNode(ctx);
        }

        const recordingMixer = ctx.createGain();
        recordingMixerRef.current = recordingMixer;

        // Connect Mic Source to the Mixer
        const micSource = ctx.createMediaStreamSource(stream);
        micSource.connect(recordingMixer);

        // Connect Mixer to the Recorder Destination
        recordingMixer.connect(recorderDestNode!);

        // Combine Video Track + Mixed Audio Track
        const videoTrack = stream.getVideoTracks()[0];
        const mixedAudioTrack = recorderDestNode!.stream.getAudioTracks()[0];
        combinedStream = new MediaStream([videoTrack, mixedAudioTrack]);
        setIsFullRecordingSupported(true);
      } catch (e) {
        console.error("Advanced audio mixing failed, using basic capture:", e);
        combinedStream = stream;
        setIsFullRecordingSupported(false);
      }

      // 4. Initialize MediaRecorder
      const types = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
      const supportedType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
      const recorder = new MediaRecorder(combinedStream, supportedType ? { mimeType: supportedType } : undefined);
      
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blobType = supportedType.includes('mp4') ? 'video/mp4' : 'video/webm';
        const fullBlob = new globalThis.Blob(chunksRef.current, { type: blobType });
        const url = URL.createObjectURL(fullBlob);
        setHistory(prev => [{
          id: Date.now().toString(),
          blob: fullBlob,
          timestamp: Date.now(),
          url: url
        }, ...prev]);
      };
      recorder.start(1000); // Collect data every second for safety

      // 5. Connect to Gemini Live
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setStatus('connected');
            
            const micSourceForGemini = ctx.createMediaStreamSource(stream);
            const scriptProcessor = ctx.createScriptProcessor(4096, 1, 1);
            
            // To prevent feedback (hearing yourself), connect to a silent gain
            const silentGain = ctx.createGain();
            silentGain.gain.value = 0;
            micSourceForGemini.connect(scriptProcessor);
            scriptProcessor.connect(silentGain);
            silentGain.connect(ctx.destination);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob: Blob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=44100', // Matches context
              };
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };

            frameIntervalRef.current = window.setInterval(() => {
              const video = videoRef.current;
              const canvas = canvasRef.current;
              const vCtx = canvas.getContext('2d');
              if (!vCtx || !video || video.readyState !== 4) return;
              canvas.width = 480; 
              canvas.height = (video.videoHeight / video.videoWidth) * canvas.width;
              vCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
              canvas.toBlob(async (blob) => {
                if (blob) {
                  const reader = new FileReader();
                  reader.onloadend = () => {
                    const base64Data = (reader.result as string).split(',')[1];
                    sessionPromise.then(s => s.sendRealtimeInput({ media: { data: base64Data, mimeType: 'image/jpeg' } }));
                  };
                  reader.readAsDataURL(blob);
                }
              }, 'image/jpeg', JPEG_QUALITY);
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && audioContextRef.current) {
              const c = audioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, c.currentTime);
              
              // Gemini returns 24kHz usually, we decode it to the 44.1kHz context
              const audioBuffer = await decodeAudioData(decode(base64Audio), c, 24000, 1);
              const source = c.createBufferSource();
              source.buffer = audioBuffer;
              
              // 1. Send to Speakers (User hears Gemini)
              source.connect(c.destination);
              
              // 2. Send to Recording Mixer (MP4 captures Gemini)
              if (recordingMixerRef.current) {
                source.connect(recordingMixerRef.current);
              }
              
              source.addEventListener('ended', () => audioSourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Session error:', e);
            setError('Connection lost.');
            stopSession();
          },
          onclose: () => stopSession()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Access error');
      setStatus('disconnected');
    }
  };

  const handleToggle = () => {
    if (status === 'disconnected' || status === 'error') {
      startSession();
    } else {
      stopSession();
    }
  };

  const downloadSession = (session: RecordedSession) => {
    const a = document.createElement('a');
    a.href = session.url;
    const ext = session.blob.type.includes('mp4') ? 'mp4' : 'webm';
    a.download = `socratic-session-${new Date(session.timestamp).toISOString()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-end font-sans overflow-hidden">
      <div className="absolute inset-0 w-full h-full overflow-hidden">
        <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
        <div className={`absolute inset-0 bg-black/40 transition-opacity duration-1000 pointer-events-none ${status === 'connected' ? 'opacity-0' : 'opacity-100'}`} />
      </div>

      {showHistory && status === 'disconnected' && (
        <div className="absolute inset-0 z-[60] bg-black/90 backdrop-blur-xl flex flex-col p-8 pt-20 animate-in fade-in duration-300">
          <header className="flex items-center justify-between mb-8">
            <h2 className="text-white text-2xl font-bold">Session History</h2>
            <button onClick={() => setShowHistory(false)} className="text-white/60 hover:text-white">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </header>
          
          <div className="flex-1 overflow-y-auto space-y-4 text-white">
            {history.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-4">
                <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center text-white/20">
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
                <p className="text-white/40 text-sm">No recorded sessions yet.</p>
              </div>
            ) : (
              history.map((s) => (
                <div key={s.id} className="bg-white/10 rounded-3xl p-6 flex items-center justify-between group border border-white/5">
                  <div className="flex items-center space-x-4">
                    <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg">
                      <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M2 6a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                        <path d="M14.553 7.106A1 1 0 0014 8v4a1 1 0 00.553.894l2 1A1 1 0 0018 13V7a1 1 0 00-1.447-.894l-2 1z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-white font-semibold">{new Date(s.timestamp).toLocaleTimeString()}</p>
                      <p className="text-white/40 text-xs">{new Date(s.timestamp).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <button onClick={() => downloadSession(s)} className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {status === 'disconnected' && !showHistory && (
        <button onClick={() => setShowHistory(true)} className="absolute top-12 right-6 z-50 w-12 h-12 rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center text-white/80 active:scale-90 transition-all border border-white/10 shadow-lg">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        </button>
      )}

      <div className="relative z-50 mb-12 flex flex-col items-center">
        {error && <div className="mb-4 text-red-500 font-bold text-xs uppercase tracking-widest bg-black/80 px-4 py-2 rounded-full shadow-lg">{error}</div>}
        <button
          onClick={handleToggle}
          disabled={status === 'connecting'}
          className={`w-24 h-24 rounded-full flex items-center justify-center transition-all duration-500 active:scale-90 shadow-2xl border-4 ${status === 'connected' ? 'bg-transparent border-white/80' : 'bg-blue-600 border-white/20'}`}
        >
          {status === 'disconnected' || status === 'error' ? (
            <svg className="w-10 h-10 text-white fill-current" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          ) : status === 'connecting' ? (
            <div className="flex space-x-1">
              <div className="w-2 h-2 bg-white rounded-full animate-bounce" />
              <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{ animationDelay: '200ms' }} />
              <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{ animationDelay: '400ms' }} />
            </div>
          ) : (
            <div className="w-10 h-10 bg-white rounded-lg shadow-inner" />
          )}
        </button>
        {status === 'connected' && (
          <div className="mt-4 flex flex-col items-center space-y-1">
             <div className="flex items-center space-x-2 bg-black/40 px-3 py-1 rounded-full backdrop-blur-sm">
              <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              <span className="text-[10px] text-white/80 font-bold tracking-widest uppercase">
                {isFullRecordingSupported ? 'Full Session Active' : 'Basic Recording Mode'}
              </span>
            </div>
            {!isFullRecordingSupported && (
              <span className="text-[8px] text-white/40 italic px-6 text-center">Audio mixing issues detected. Recording might only include your voice.</span>
            )}
          </div>
        )}
      </div>
      <div className="absolute bottom-1 w-32 h-1 bg-white/10 rounded-full z-50" />
    </div>
  );
};

export default App;
