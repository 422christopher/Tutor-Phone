
export interface SessionConfig {
  voiceName: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
  systemInstruction: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface TranscriptionEntry {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}
