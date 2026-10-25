/**
 * 黄金回归集夹具 —— 事故 6 笔被误拦截的正常 read/grep/pwsh 切片浏览实参。
 * 来源：宿主仓 docs/空转会话复盘-20261010-01-全文记录.md
 *   #1 :598 (seq29/step2, pwsh)        → G2-A
 *   #2 :666 (seq38/step3, pwsh)        → G2-A
 *   #3 :1007 (seq67/step5, pwsh)       → G2-B
 *   #4 :2704-2707 (seq126/step10, read)→ G2-A
 *   #5 :4340-4342 (seq200/step19,grep) → G2-A
 *   #6 :4367-4369 (seq205/step20,grep) → G2-A
 * 断言③要求这 6 笔在解耦的"零误杀"判定下全部判放行。
 * 注：PUBLIC 仓发布前已对实参脱敏（<WORKSPACE> 代工作区根、%USERPROFILE% 代用户目录），
 * 仅替换路径前缀，保留双根/同目标形状，不改变 name/args 归一化后的 G2 判定。
 */
export const INCIDENT_INTERCEPTIONS = [
	{
		id: "inc-1", turn: 1, step: 2, name: "pwsh",
		args: {
			command: 'Get-ChildItem -Path <WORKSPACE>, %USERPROFILE%\\.dsh -Recurse -Filter "*<PKG>*" -ErrorAction SilentlyContinue | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize'
		},
		blockedCode: "g2a-same-target"
	},
	{
		id: "inc-2", turn: 1, step: 3, name: "pwsh",
		args: {
			command: 'Get-ChildItem -Path <WORKSPACE>\\work -Recurse -Filter "*.ps1"; Get-ChildItem -Path %USERPROFILE%\\.dsh -MaxDepth 2 -Recurse -Name'
		},
		blockedCode: "g2a-same-target"
	},
	{
		id: "inc-3", turn: 1, step: 5, name: "pwsh",
		args: {
			command: 'Get-ChildItem -Path %USERPROFILE%\\.dsh\\profiles\\<PROFILE>\\node_modules\\<PKG> -Recurse -File; Get-Content ...\\<PKG>\\package.json'
		},
		blockedCode: "g2b-consecutive-failure"
	},
	{
		id: "inc-4", turn: 1, step: 10, name: "read",
		args: {
			file_path: "%USERPROFILE%\\.dsh\\profiles\\<PROFILE>\\node_modules\\<PKG>\\providers\\<PROVIDER>\\<FILE>",
			offset: 481, limit: 220
		},
		blockedCode: "g2a-same-target"
	},
	{
		id: "inc-5", turn: 1, step: 19, name: "grep",
		args: {
			pattern: "const outcome|while|do |return 'fallback'|outcome ===|streamStarted.v = true|fnValue = ",
			path: "%USERPROFILE%\\.dsh\\profiles\\<PROFILE>\\node_modules\\<PKG>\\providers\\<PROVIDER>\\<FILE>"
		},
		blockedCode: "g2a-same-target"
	},
	{
		id: "inc-6", turn: 1, step: 20, name: "grep",
		args: {
			pattern: "const outcome|fallbackUsed = true|fnValue = 'chat_v3'|while \\(|do \\{|streamStarted\\.v = true|return 'fallback'",
			path: "%USERPROFILE%\\.dsh\\profiles\\<PROFILE>\\node_modules\\<PKG>\\providers\\<PROVIDER>\\<FILE>"
		},
		blockedCode: "g2a-same-target"
	}
];