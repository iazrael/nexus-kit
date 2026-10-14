/**
 * 诊断全文截短（复制到聊天用）：聊天应用对单条消息长度有限制、粘贴大段文本会卡，日志多时全文有几十 KB。
 * 头部摘要（环境、上次退出等节）对排查最要紧，完整保留；「## 日志」节只取最近的整行，保留部分前补上它所属会话的
 * 分隔行（开发者分得清是本次还是上次），并在节首注明省略了多少行。最后一行本身就超出预算（长堆栈）时截前半段保留。
 * 省略说明的措辞（例如完整内容该点哪个按钮）归宿主，默认只说省略了多少行。上限没有对各聊天应用实测，由宿主调整。
 */
export interface TruncateOptions {
    /** 省略说明，参数是省略的日志行数 */
    note?: (omitted: number) => string;
}
export declare function truncateExport(text: string, maxChars: number, options?: TruncateOptions): string;
