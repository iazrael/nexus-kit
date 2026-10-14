import type { AgyConfig } from "./types.ts";
export declare function agySessions(path: string, expected?: string | null): () => string | null;
export declare function agyResult(path: string): {
    conversation_id: string;
};
/** 当前唯一执行器的启动合同：命令、会话、模型、权限和输出格式。 */
export declare function agyInvocation(config: AgyConfig, conversation: string | null, logFile: string, prompt: string): {
    exe: string;
    argv: string[];
};
