export interface Message {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    isStreaming?: boolean;
}

export interface SystemEvent {
    id: string;
    timestamp: string;
    type: "UtteranceFinal" | "TalkerResponse" | "AvatarCommand" | "Speak" | "System";
    details: string;
}
