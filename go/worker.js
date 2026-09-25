// 在后台线程里排路线，界面不卡。主线程发 {id, state}，回 {id, plan}。
// v2 的 state（有 trip）→ 整趟分天排（tripPlan.js）；旧的 v1 → 只排一天（plan.js）。
import { makeTransit } from './transit.js';
import { makePlan } from './plan.js';
import { makeTrip } from './tripPlan.js';

const ready = fetch('数据/hk.json').then(r => r.json()).then(d => ({ d, T: makeTransit(d) }));

self.onmessage = async e => {
  const { id, state } = e.data;
  let plan;
  try {
    const { d, T } = await ready;
    plan = state && state.v >= 2 ? makeTrip(state, d, T) : makePlan(state, d, T);
  } catch (err) {
    plan = { ok: false, error: err.message };
  }
  self.postMessage({ id, plan });
};
