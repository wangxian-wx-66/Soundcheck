# global_search 未启用与 zhida 未接入的判决记录

日期：2026-09-14（提交前夜）| 触发：产品说明事实核查发现文档初稿与代码不符

## 结论先行

| 接口 | 状态 | 判决 |
|---|---|---|
| global_search（全网搜索） | 适配层 + 执行分支完整，但 TOOLS 数组未暴露 → LLM 永远不会调用 | **bug（半接线），当次不修** |
| zhida（直答） | 适配层未实现（lib/ 零命中） | **不是 bug，晋级阶梯有意砍掉的范围决策** |

## 证据链

### global_search：bug 的完整证据

1. 计划书原计划包含它：开发计划 §3.1 主管线图明确「自主决定检索词 → zhihu_search / global_search」，§六技术架构表两者并列为 HTTP 直连通道
2. 适配层完整：lib/zhihu.mjs:145 `globalSearch` 全实现（缓存键、调用计数、Filter 参数）
3. 执行分支完整：lib/pipeline.mjs:371 `executeTool` 有 `zhihu_search || global_search` 双分支
4. **唯独 TOOLS 数组漏挂**：git 考古（`git show a0be1af:lib/pipeline.mjs`）确认 P0-A 首次落地提交时 TOOLS 就只有 zhihu_search 和 question_answers 两项，至今未变——LLM 从不知道 global_search 存在
5. 为什么两天没人发现：zhihu_search + question_answers 双证据链自洽闭环，核心场景不缺功能；47 项单测 + 15 项冒烟全过，线上全链路验证过——半接线的插座不漏电就不会报错

### zhida：有意决策的证据

1. 计划书 §2.1 判定天花板：「仅支持 model/messages/stream，无 tools → 不能当 Agent 大脑，只做彩蛋」
2. 额度账定位：L4 彩蛋 ≤1 次/分析，排最末级
3. 晋级阶梯：彩蛋列在 P3（9/15 凌晨仍有余力才做），从未进入 P0-P2
4. 砍得对：转述他人回答且引用细节不可交叉验证，实测单次 23.6 秒——48h 赛程、完成度占 25% 的评分下，优先级天然让位

## 不修的理由（三条）

1. 演示问题已按当前工具集预热缓存，改 TOOLS 数组会改变 LLM 检索行为，预热作废
2. 加工具 = 加不可控性，没有时间跑完整回归就要重新构建推送部署
3. 评审期 9/15-9/23 冻结重部署，改了也上不去

## 实际影响评估

接近零。global_search 的增量价值（全网来源、Filter 语法、Count 20）对「对比知乎已有回答」的核心主张没有贡献——证据边界声明以知乎默认排序为锚，全网内容反而稀释叙事。

## 赛后修复方案（一行改动 + 一条测试）

- lib/pipeline.mjs TOOLS 数组追加 global_search 工具定义（6 行：name/description/parameters）
- 测试锚点：mock LLM 发起 global_search 调用，断言走 `zhihu.globalSearch` 分支且缓存键含 Filter 参数
- 修之前先重新想用途：如果启用，应该在什么场景触发（站内证据不足的判定标准）、结果如何标注「非站内证据」——而不是简单塞回工具菜单

## 附带修正

产品说明初稿因此改了三处：能力表删除 zhida 和 global_search 两行、global_search 改标「已接入预留，当前未启用」、杠精 Agent「并行」改「接力」。文档口径已与代码对齐。
