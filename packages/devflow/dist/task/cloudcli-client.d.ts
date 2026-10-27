/** 桥接进程向 stdout 写统一回执，增量事件保存在独立日志。 */
export declare function runCloudcli(requestFile: string): Promise<number>;
/** 监督进程在桥接退出后调用；只有服务端确认停止才允许审计和提交中断记录。 */
export declare function stopCloudcli(requestFile: string): Promise<void>;
