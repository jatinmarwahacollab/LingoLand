export interface Character {
  id: string;
  name: string;
  emoji: string;
  description: string;
  voiceName: string; // 'Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'
  systemPrompt: string;
  color: string; // Tailwind gradient class
  baseColorHex: string; // For canvas visualizer
}

export type Role = 'user' | 'model';

export interface TranscriptItem {
  role: Role;
  text: string;
}

export interface AudioState {
  isConnected: boolean;
  isSpeaking: boolean; // Is the model speaking?
  volume: number; // 0-100 for visualization
}