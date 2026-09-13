// 共享错误类型：跨模块识别超时/熔断
export class PipelineTimeoutError extends Error {
  constructor(message = '分析超时（全管线 5 分钟熔断）') { super(message); this.code = 'PIPELINE_TIMEOUT'; }
}
export function createLlmTimeoutError() {
  const error = new Error('LLM 单轮调用超时（60s 熔断）');
  error.code = 'LLM_TIMEOUT';
  return error;
}
export class BudgetExhaustedError extends Error {
  constructor(message = '工具调用预算耗尽') { super(message); this.code = 'BUDGET_EXHAUSTED'; }
}
