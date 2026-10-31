import type { TaskConfig } from "../task/types.ts";
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
export interface WorktreeConfig {
    /** 工作树父目录（相对主仓库根）；未配置默认 ".worktrees"；null = 主仓库同级的「<仓库目录名>-worktrees」 */
    dir: string | null;
    /** 主干分支：合入目标，也是新工作树的默认起点 */
    base: string;
    /** 主仓库的预览端口；工作树从 portBase + portStep 起按 portStep 分配 */
    portBase: number;
    portStep: number;
    /** 不入 git、建树时软链回主仓库共享的路径（相对仓库根） */
    share: string[];
    /** share 里允许隔离成本树副本的项（isolate 与建树 --isolate 的可选名字），缺省等于 share；只读原料不列进来 */
    isolatable: string[];
    /** 回收时视为可再生的额外被忽略路径（相对仓库根，按路径段前缀） */
    disposable: string[];
    /** 建树后在新工作树里依次执行的命令（argv 数组） */
    postCreate: string[][];
    /** 合入后在主仓库依次执行的命令；失败即非零退出 */
    postMerge: string[][];
}
export interface ReleaseConfig {
    /** 发版链里部署前后的固定步骤（argv 数组，主仓库执行），每步之后核对 HEAD 未变 */
    steps: string[][];
    /** 发版链放锁的有效分钟数（进程被强杀留残锁时到期自动失效） */
    lockTtlMin: number;
    /** release --lock 手动放锁的默认有效分钟数（落款与门禁期间冻结主干） */
    holdTtlMin: number;
    /** 打 tag 后推送主干与 tag 到 origin */
    push: boolean;
    /** 推送后用 gh 创建 GitHub Release（正文 = 落款小节全量条目） */
    githubRelease: boolean;
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
    worktree: WorktreeConfig;
    release: ReleaseConfig;
    task: TaskConfig | null;
}
export declare const CONFIG_FILE = "nexus.config.json";
export declare const DEFAULT_PRIVATE_REQUIRED: string[];
/** 发版链默认步骤：完成标准 → 构建 → 部署（部署自带冒烟与失败回滚） */
export declare const DEFAULT_RELEASE_STEPS: string[][];
export declare function parseNexusConfig(raw: unknown, repoRoot: string, env?: NodeJS.ProcessEnv): NexusConfig;
/** 只读 dir 下的配置，不向上查找：合入后不能借用上级目录里别的项目的配置。 */
export declare function loadNexusConfigAt(dir: string, env?: NodeJS.ProcessEnv): NexusConfig;
export declare function loadNexusConfig(cwd?: string, env?: NodeJS.ProcessEnv): NexusConfig;
export declare function loadChangelogConfig(cwd?: string): Pick<NexusConfig, "repoRoot" | "changelog">;
