
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';
import { decode, encode, decodeAudioData } from './utils/audioHelpers';
import Visualizer from './components/Visualizer';
import { ConnectionStatus, TranscriptionEntry } from './types';

// Constants
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const SYSTEM_INSTRUCTION = `You are a world-class Socratic tutor. 
Your goal is to help the user learn by asking guiding questions rather than providing direct answers. 
You can see the user's iPad screen through the video stream provided as image frames. 

CRITICAL BEHAVIOR:
1. Observe carefully: Look at what they are doing, what they are writing (if they use an Apple Pencil), or what app they are in.
2. Socratic Method: If they are stuck on a problem, ask "What do you think is the first step here?" or "I see you wrote X, how does that relate to Y?"
3. Concise: Keep verbal responses short and human-like.
4. Encouraging: Use a warm, supportive tone.
5. Contextual: If you see they are in a specific app (like Notes or a calculator), acknowledge it to build trust.
Do not provide full solutions. If they ask for the answer, gently nudge them back to the logic.`;

const FRAME_RATE = 1; // 1 FPS is plenty for tutoring and saves tokens/bandwidth
const JPEG_QUALITY = 0.4; // Optimized for performance

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for managing state without re-renders
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const currentInputTranscriptionRef = useRef('');
  const currentOutputTranscriptionRef = useRef('');

  const stopSession = useCallback(() => {
    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }

    if (sessionRef.current) {
      sessionRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
    }

    audioSourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    audioSourcesRef.current.clear();

    if (audioContextInRef.current) audioContextInRef.current.close();
    if (audioContextOutRef.current) audioContextOutRef.current.close();

    setStatus('disconnected');
    setIsScreenSharing(false);
  }, []);

  const startSession = async () => {
    try {
      setStatus('connecting');
      setError(null);

      // Check for screen capture support
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        throw new Error("Screen sharing is not supported in this browser environment.");
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

      // Initialize Audio
      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      // Request Microphone
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = micStream;

      // Request Screen Share with specific error handling for Permission Policy
      let displayStream: MediaStream;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({ 
          video: {
            displaySurface: 'monitor',
            cursor: 'always'
          } as any,
          audio: false 
        });
      } catch (e: any) {
        if (e.name === 'NotAllowedError') {
          throw new Error("Permission denied. Ensure your browser allows screen capture for this site.");
        } else {
          throw new Error(`Screen capture error: ${e.message}`);
        }
      }
      
      screenStreamRef.current = displayStream;
      setIsScreenSharing(true);

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setStatus('connected');
            
            // Audio Input Bridge
            const source = audioContextInRef.current!.createMediaStreamSource(micStream);
            const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob: Blob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };

              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current!.destination);

            // Frame Streaming Loop
            const videoEl = document.createElement('video');
            videoEl.srcObject = displayStream;
            videoEl.play();

            frameIntervalRef.current = window.setInterval(() => {
              const canvas = canvasRef.current;
              const ctx = canvas.getContext('2d');
              if (!ctx || !videoEl.videoWidth) return;

              // iPad aspect ratio optimization (scaled down for bandwidth)
              canvas.width = 640; 
              canvas.height = (videoEl.videoHeight / videoEl.videoWidth) * canvas.width;
              
              ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
              canvas.toBlob(async (blob) => {
                if (blob) {
                  const reader = new FileReader();
                  reader.onloadend = () => {
                    const base64Data = (reader.result as string).split(',')[1];
                    sessionPromise.then(session => {
                      session.sendRealtimeInput({
                        media: { data: base64Data, mimeType: 'image/jpeg' }
                      });
                    });
                  };
                  reader.readAsDataURL(blob);
                }
              }, 'image/jpeg', JPEG_QUALITY);
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              currentInputTranscriptionRef.current += message.serverContent.inputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const uTrans = currentInputTranscriptionRef.current;
              const mTrans = currentOutputTranscriptionRef.current;
              
              if (uTrans || mTrans) {
                setTranscriptions(prev => [
                  ...prev,
                  ...(uTrans ? [{ role: 'user', text: uTrans, timestamp: Date.now() } as const] : []),
                  ...(mTrans ? [{ role: 'model', text: mTrans, timestamp: Date.now() } as const] : [])
                ].slice(-50)); // Keep history manageable
              }
              
              currentInputTranscriptionRef.current = '';
              currentOutputTranscriptionRef.current = '';
            }

            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && audioContextOutRef.current) {
              const ctx = audioContextOutRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              
              source.addEventListener('ended', () => {
                audioSourcesRef.current.delete(source);
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => {
                try { s.stop(); } catch(e) {}
              });
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Gemini Live Error:', e);
            setError('The connection was lost. Re-enabling sharing might help.');
            stopSession();
          },
          onclose: () => {
            stopSession();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to start tutor session');
      setStatus('disconnected');
      setIsScreenSharing(false);
    }
  };

  return (
    <div className="flex flex-col h-screen w-full bg-[#f2f2f7] p-4 lg:p-10 select-none">
      <div className="flex flex-col md:flex-row h-full w-full max-w-[1400px] mx-auto bg-white/80 backdrop-blur-3xl rounded-[3rem] overflow-hidden ipad-shadow border border-white/50 relative">
        
        {/* Sidebar */}
        <div className="w-full md:w-80 flex flex-col border-r border-gray-200/40 p-8 space-y-10 bg-[#fefefe]/50">
          <div>
            <div className="flex items-center space-x-2 text-blue-600 mb-2">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10.394 2.08a1 1 0 00-.788 0l-7 3a1 1 0 000 1.84L5.25 8.051a.999.999 0 01.356-.257l4-1.714a1 1 0 11.788 1.838L7.667 9.088l1.94.831a1 1 0 00.787 0l7-3a1 1 0 000-1.838l-7-3z" />
                <path d="M7.601 13.591l-1.39-4.634c.547-.304 1.176-.457 1.799-.457s1.252.153 1.799.457l-1.39 4.634A1 1 0 017.601 13.591z" />
              </svg>
              <span className="text-xs font-bold uppercase tracking-[0.2em]">Learning Hub</span>
            </div>
            <h1 className="text-3xl font-extrabold text-gray-900 leading-tight">Socratic Tutor</h1>
            <p className="text-sm text-gray-500 mt-2 font-medium">Empowering your curiosity</p>
          </div>

          <div className="space-y-6">
            <div className={`p-5 rounded-3xl flex items-center justify-between transition-all duration-500 ${status === 'connected' ? 'bg-blue-50 text-blue-700 shadow-inner' : 'bg-gray-100 text-gray-500'}`}>
              <div className="flex items-center space-x-3">
                <div className={`w-2.5 h-2.5 rounded-full ${status === 'connected' ? 'bg-blue-500 animate-pulse' : 'bg-gray-400'}`} />
                <span className="text-sm font-bold tracking-tight">{status === 'connected' ? 'Tutor Active' : 'Ready to Start'}</span>
              </div>
            </div>

            {status === 'disconnected' || status === 'error' ? (
              <button
                onClick={startSession}
                className="w-full py-5 bg-blue-600 hover:bg-blue-700 active:scale-[0.97] transition-all text-white rounded-[1.8rem] font-bold shadow-2xl shadow-blue-500/30 flex items-center justify-center space-x-3 group"
              >
                <span className="bg-white/20 p-1.5 rounded-full group-hover:rotate-12 transition-transform">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  </svg>
                </span>
                <span className="text-lg">Open Session</span>
              </button>
            ) : (
              <button
                onClick={stopSession}
                className="w-full py-5 bg-black hover:bg-gray-900 active:scale-[0.97] transition-all text-white rounded-[1.8rem] font-bold flex items-center justify-center space-x-3"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-lg text-red-400">Close Tutor</span>
              </button>
            )}
          </div>

          {error && (
            <div className="p-5 bg-red-50 text-red-600 rounded-2xl text-xs font-medium border border-red-100 flex items-start space-x-3 animate-in slide-in-from-top-2">
              <svg className="w-5 h-5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          <div className="flex-1 flex flex-col justify-end pb-4">
            <div className="bg-gray-100/50 p-6 rounded-[2rem] border border-white/80 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Audio Feedback</span>
                <div className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-red-500' : 'bg-gray-300'}`} />
              </div>
              <div className="h-10 w-full overflow-hidden">
                <Visualizer isActive={status === 'connected'} color="#007AFF" />
              </div>
            </div>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-h-0 bg-white/40">
          <header className="px-10 py-8 border-b border-gray-200/30 flex items-center justify-between bg-white/60 backdrop-blur-xl">
            <div className="flex items-center space-x-5">
               <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
                 <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                 </svg>
               </div>
               <div>
                 <h2 className="text-xl font-bold text-gray-900 tracking-tight">Active Guidance</h2>
                 <div className="flex items-center space-x-2 mt-0.5">
                   <span className="relative flex h-2 w-2">
                     <span className={`animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 ${isScreenSharing ? 'block' : 'hidden'}`}></span>
                     <span className={`relative inline-flex rounded-full h-2 w-2 ${isScreenSharing ? 'bg-blue-500' : 'bg-gray-300'}`}></span>
                   </span>
                   <p className="text-xs text-gray-500 font-medium">{isScreenSharing ? 'Sharing iPad Screen' : 'Screen share waiting'}</p>
                 </div>
               </div>
            </div>
            
            <div className="hidden sm:flex items-center bg-gray-100/80 px-4 py-2 rounded-full border border-gray-200/50">
               <div className="flex -space-x-2 mr-3">
                 <div className="w-6 h-6 rounded-full bg-blue-100 border-2 border-white flex items-center justify-center text-[10px] font-bold text-blue-600">S</div>
                 <div className="w-6 h-6 rounded-full bg-gray-200 border-2 border-white flex items-center justify-center text-[10px] font-bold text-gray-600">U</div>
               </div>
               <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Socratic Session v2.5</span>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto p-8 lg:p-12 space-y-8 scrollbar-hide">
            {transcriptions.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto animate-in fade-in zoom-in duration-700">
                <div className="w-24 h-24 bg-gradient-to-tr from-blue-50 to-white rounded-[2.5rem] shadow-sm flex items-center justify-center text-blue-500 mb-8 border border-blue-100/50">
                  <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
                <h3 className="text-2xl font-extrabold text-gray-900 tracking-tight">How can I help you today?</h3>
                <p className="text-gray-500 mt-4 text-base leading-relaxed font-medium">
                  Share your screen and tell me what you're working on. I'll watch your progress and guide your thinking with helpful hints.
                </p>
                <div className="mt-8 grid grid-cols-2 gap-3 w-full">
                  <div className="p-4 bg-white/80 rounded-2xl border border-gray-100 text-[13px] font-semibold text-gray-600">Ask for a hint</div>
                  <div className="p-4 bg-white/80 rounded-2xl border border-gray-100 text-[13px] font-semibold text-gray-600">Solve math</div>
                </div>
              </div>
            ) : (
              transcriptions.map((t, idx) => (
                <div key={idx} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-4 duration-500`}>
                  <div className={`max-w-[75%] px-6 py-4 rounded-[2rem] shadow-sm ${
                    t.role === 'user' 
                      ? 'bg-blue-600 text-white rounded-tr-md' 
                      : 'bg-white text-gray-800 rounded-tl-md border border-gray-100/50'
                  }`}>
                    <p className="text-sm font-medium leading-relaxed tracking-tight">{t.text}</p>
                    <div className={`flex items-center space-x-1 mt-2 ${t.role === 'user' ? 'text-blue-200' : 'text-gray-300'}`}>
                      <span className="text-[9px] font-bold uppercase tracking-wider">
                        {new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </main>

          {status === 'connected' && (
            <div className="p-8 lg:p-12 pt-0">
               <div className="bg-blue-600 text-white rounded-[2.5rem] p-6 flex items-center justify-between shadow-2xl shadow-blue-500/40 animate-in slide-in-from-bottom-8 duration-700">
                 <div className="flex items-center space-x-5">
                    <div className="flex items-center justify-center space-x-1.5 px-3 py-2 bg-white/20 rounded-full">
                      <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{ animationDelay: '200ms' }} />
                      <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{ animationDelay: '400ms' }} />
                    </div>
                    <div>
                      <span className="text-sm font-bold block leading-none">Tutor Watching</span>
                      <span className="text-[10px] text-blue-100 font-medium uppercase tracking-widest mt-1 inline-block">Socratic Reasoning Active</span>
                    </div>
                 </div>
                 <button 
                  onClick={stopSession} 
                  className="px-6 py-2.5 bg-white text-blue-600 rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-blue-50 transition-colors shadow-lg"
                 >
                   End Session
                 </button>
               </div>
            </div>
          )}
        </div>
      </div>

      {/* iPad Home Indicator */}
      <footer className="mt-6 flex justify-center">
        <div className="w-36 h-1.5 bg-gray-400/30 rounded-full" />
      </footer>
    </div>
  );
};

export default App;
