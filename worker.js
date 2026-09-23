// 在后台线程里排路线，界面不卡。主线程发 {id, state}，回 {id, plan}。
import { makeTransit } from './transit.js';
import { makePlan } from './plan.js';

const ready = fetch('数据/hk.json').then(r => r.json()).then(d => ({ d, T: makeTransit(d) }));

self.onmessage = async e => {
  const { id, state } = e.data;
  let plan;
  try {
    const { d, T } = await ready;
    plan = makePlan(state, d, T);
  } catch (err) {
    plan = { ok: false, error: err.message };
  }
  self.postMessage({ id, plan });
};
