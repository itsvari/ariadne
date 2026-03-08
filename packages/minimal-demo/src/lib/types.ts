export interface Message {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    reasoning?: string;
    speakerId?: number;
    toolCalls?: { name: string; args: string }[];
    isStreaming?: boolean;
}

export interface SystemEvent {
    id: string;
    timestamp: string;
    type: "UtteranceFinal" | "TalkerResponse" | "AvatarCommand" | "Speak" | "System";
    details: string;
}
