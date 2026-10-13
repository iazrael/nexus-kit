export interface DeployConfig {
    /** ssh 目标，如 root@1.2.3.4 */
    target: string;
    /** 服务器部署根（其下 releases/ 与 current 软链） */
    remoteRoot: string;
    /** 公网地址（边缘 TTL 探针用；空串 = 不探） */
    publicUrl: string;
    /** 服务器回环端口（nginx 只监听 127.0.0.1 的端口，冒烟走它） */
    localPort: number;
    /** 保留最近几版 */
    keep: number;
    /** 只允许从哪个分支部署 */
    branch: string;
    /** 必须带 Cache-Control: private 的路径（更新链关键文件） */
    privateRequired: string[];
    /** 必须 gzip 下发的路径 */
    gzipRequired: string[];
    /** 公网边缘 TTL 探针：不带哈希、每版都在的常驻文件 */
    edgeTtlProbes: string[];
}
export interface NexusConfig {
    /** 仓库根（配置文件所在目录） */
    repoRoot: string;
    /** 应用根（package.json、CHANGELOG.md、dist/ 所在），相对仓库根，默认 "." */
    appRoot: string;
    /** CHANGELOG 门禁：源码目录前缀（相对仓库根）与 CHANGELOG 路径 */
    changelog: {
        path: string;
        sourceDirs: string[];
    };
    /** 文档审计：文档根、存档目录、设计稿目录、索引文件（活文档必须登记在这里） */
    docs: {
        root: string;
        archiveDir: string;
        designDir: string;
        index: string;
    };
    deploy: DeployConfig | null;
}
export declare const CONFIG_FILE = "nexus.config.json";
export declare const DEFAULT_PRIVATE_REQUIRED: string[];
export declare function parseNexusConfig(raw: unknown, repoRoot: string, env?: NodeJS.ProcessEnv): NexusConfig;
/** 从 cwd 向上找 nexus.config.json；找不到抛错 */
export declare function loadNexusConfig(cwd?: string, env?: NodeJS.ProcessEnv): NexusConfig;
