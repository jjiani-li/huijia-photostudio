import { describe, expect, it, vi } from 'vitest';
import type { ReverseSuggestion } from '../../src/shared/reverse-suggestion';
import type { EraSceneProfile } from '../../src/shared/types';
import {
  applyReverseSuggestion,
  confirmPath,
  disabledReason,
  GATE_COPY,
  generateGate,
  isLowConfidence,
  matchSelection,
  quotaHint,
  readSelection,
  startGeneration,
  shouldRedirectToConfirm,
  writeSelection,
  type GateInput,
  type SearchParamsLike,
  type Selection,
} from './selection';

/**
 * `/choose/[anchorId]` 的纯逻辑（`docs/prd/pages/P02-年代与场景选择.md` §10）：
 * URL 读写与规范化、低置信判据、置灰判据与文案、守卫判据、反推推荐的接住口径。
 */
const params = (query: string): SearchParamsLike => new URLSearchParams(query);

const GATE_BASE: GateInput = { eraCode: 'E2', sceneId: 3, remaining: 20, count: 2, busy: false };

describe('readSelection / writeSelection（§10：规范化，非法值回退不抛）', () => {
  it('读满三个参数', () => {
    expect(readSelection(params('era=E2&scene=3&count=3'))).toEqual({
      eraCode: 'E2',
      sceneId: 3,
      count: 3,
    });
  });

  it('年代代号大小写归一；非代号形状 → null', () => {
    expect(readSelection(params('era=e2')).eraCode).toBe('E2');
    for (const bad of ['E', 'E2x', 'S1', '2', 'E-2', '']) {
      expect(readSelection(params(`era=${bad}`)).eraCode, bad).toBeNull();
    }
  });

  it('`scene` 必须是整数 `scenes.id`，不是 `S1` 这类代号', () => {
    expect(readSelection(params('scene=12')).sceneId).toBe(12);
    for (const bad of ['S1', '0', '-3', '1.5', 'E2', 'abc', '']) {
      expect(readSelection(params(`scene=${bad}`)).sceneId, bad).toBeNull();
    }
  });

  it('`count` 只认 2 / 3 / 4，其余（含缺省）回退 2', () => {
    expect(readSelection(params('count=4')).count).toBe(4);
    for (const bad of ['', 'count=5', 'count=1', 'count=abc']) {
      expect(readSelection(params(bad)).count, bad).toBe(2);
    }
  });

  it('空查询串 → 全未选 + 缺省 2 张', () => {
    expect(readSelection(params(''))).toEqual({ eraCode: null, sceneId: null, count: 2 });
  });

  it('写回：`count` 为缺省 2 时不写；全空时只回路径', () => {
    expect(writeSelection('/choose/1', { eraCode: 'E2', sceneId: 3, count: 2 })).toBe(
      '/choose/1?era=E2&scene=3',
    );
    expect(writeSelection('/choose/1', { eraCode: 'E4', sceneId: 5, count: 3 })).toBe(
      '/choose/1?era=E4&scene=5&count=3',
    );
    expect(writeSelection('/choose/1', { eraCode: null, sceneId: null, count: 2 })).toBe('/choose/1');
  });

  it('读写往返稳定', () => {
    for (const selection of [
      { eraCode: 'E1', sceneId: 1, count: 4 },
      { eraCode: 'E3', sceneId: 4, count: 3 },
    ] satisfies Selection[]) {
      expect(readSelection(params(writeSelection('/choose/9', selection).split('?')[1] ?? ''))).toEqual(selection);
    }
  });
});

describe('matchSelection（§10：URL 里的值还要对一遍配置表）', () => {
  const config = { eras: [{ code: 'E2' }], scenes: [{ id: 3 }] };

  it('配置里存在才认；形状合法但不存在 → 当未选', () => {
    expect(matchSelection(config, { eraCode: 'E2', sceneId: 3, count: 2 })).toEqual({
      eraCode: 'E2',
      sceneId: 3,
      count: 2,
    });
    expect(matchSelection(config, { eraCode: 'E9', sceneId: 99, count: 2 })).toEqual({
      eraCode: null,
      sceneId: null,
      count: 2,
    });
  });
});

describe('isLowConfidence（§5：低于阈值才提示，等于不提示，无档案不提示）', () => {
  const profile = (confidence: number): EraSceneProfile => ({
    eraCode: 'E3',
    sceneId: 1,
    confidence,
    visualSignature: 'x',
    sampleUrl: null,
  });

  it('低于阈值 → true（0.6 阈值下 0.55 / 0.2）', () => {
    expect(isLowConfidence(profile(0.55), 0.6)).toBe(true);
    expect(isLowConfidence(profile(0.2), 0.6)).toBe(true);
  });

  it('等于或高于阈值 → false', () => {
    expect(isLowConfidence(profile(0.6), 0.6)).toBe(false);
    expect(isLowConfidence(profile(0.9), 0.6)).toBe(false);
  });

  it('profile === null → false（不提示也不推断）', () => {
    expect(isLowConfidence(null, 0.6)).toBe(false);
  });

  it('阈值来自响应，不写死：阈值 0.5 时 0.55 不再提示', () => {
    expect(isLowConfidence(profile(0.55), 0.5)).toBe(false);
  });
});

describe('generateGate / disabledReason（§7：未选完 / 额度不足 / 请求中）', () => {
  it('四类判据各自的 gate 与逐字文案', () => {
    expect(generateGate(GATE_BASE)).toBeNull();
    expect(disabledReason(GATE_BASE)).toBeNull();

    expect(generateGate({ ...GATE_BASE, busy: true })).toBe('busy');
    expect(disabledReason({ ...GATE_BASE, busy: true })).toBe('正在生成，大概要等一会儿');

    expect(generateGate({ ...GATE_BASE, eraCode: null })).toBe('incomplete');
    expect(generateGate({ ...GATE_BASE, sceneId: null })).toBe('incomplete');
    expect(disabledReason({ ...GATE_BASE, sceneId: null })).toBe('上面先各选一个');

    expect(generateGate({ ...GATE_BASE, remaining: 1 })).toBe('quota');
    expect(disabledReason({ ...GATE_BASE, remaining: 1 })).toBe('今天的额度不够了');
  });

  it('优先级：请求中 > 未选完 > 额度不足', () => {
    expect(generateGate({ eraCode: null, sceneId: null, remaining: 0, count: 4, busy: true })).toBe('busy');
    expect(generateGate({ eraCode: null, sceneId: null, remaining: 0, count: 4, busy: false })).toBe('incomplete');
  });

  it('额度未取到（null）时不按额度置灰；剩余恰好等于张数可生成', () => {
    expect(generateGate({ ...GATE_BASE, remaining: null })).toBeNull();
    expect(generateGate({ ...GATE_BASE, remaining: 2, count: 2 })).toBeNull();
    expect(generateGate({ ...GATE_BASE, remaining: 3, count: 4 })).toBe('quota');
  });

  it('文案表穷尽每一个 gate（新增 gate 会被类型检查拦下）', () => {
    for (const gate of ['busy', 'incomplete', 'quota'] as const) {
      expect(GATE_COPY[gate]).toBeTruthy();
    }
    expect(quotaHint(3)).toBe('今天还能生成 3 张');
  });
});

describe('shouldRedirectToConfirm（§2、SEC-01 的前端半段）', () => {
  it('未确认 → 回确认页；已确认 → 留在本页', () => {
    expect(shouldRedirectToConfirm({ confirmedByUser: false })).toBe(true);
    expect(shouldRedirectToConfirm({ confirmedByUser: true })).toBe(false);
    expect(confirmPath(12)).toBe('/confirm/12');
  });
});

describe('startGeneration（P00 §12：置灰时不发起 POST /api/generations）', () => {
  const post = () => vi.fn(async () => ({ generation: { id: 42 } }));
  const base = { anchorId: 7, eraCode: 'E2', sceneId: 3, count: 2 as const, remaining: 20, busy: false };

  it('未选年代 / 未选场景 → 一个请求都不发', async () => {
    for (const over of [{ eraCode: null }, { sceneId: null }]) {
      const poster = post();
      const outcome = await startGeneration({ ...base, ...over, post: poster });
      expect(outcome).toEqual({ started: false, gate: 'incomplete' });
      expect(poster).not.toHaveBeenCalled();
    }
  });

  it('额度不足 / 请求进行中 → 一个请求都不发', async () => {
    const quotaPoster = post();
    expect(await startGeneration({ ...base, remaining: 1, post: quotaPoster })).toEqual({
      started: false,
      gate: 'quota',
    });
    expect(quotaPoster).not.toHaveBeenCalled();

    const busyPoster = post();
    expect(await startGeneration({ ...base, busy: true, post: busyPoster })).toEqual({
      started: false,
      gate: 'busy',
    });
    expect(busyPoster).not.toHaveBeenCalled();
  });

  it('选完且有额度 → 按契约的四个字段发起一次，返回新任务 id', async () => {
    const poster = post();
    const outcome = await startGeneration({ ...base, count: 4, post: poster });
    expect(outcome).toEqual({ started: true, generationId: 42 });
    expect(poster).toHaveBeenCalledTimes(1);
    expect(poster).toHaveBeenCalledWith({ anchorId: 7, eraCode: 'E2', sceneId: 3, count: 4 });
  });
});

describe('applyReverseSuggestion（§7：接住推荐初值）', () => {
  const taker = (value: ReverseSuggestion | null) => vi.fn(() => value);

  it('URL 未带 era / scene 时用内存态推荐补 URL，并消费掉推荐', () => {
    const take = taker({ eraCode: 'E2', sceneId: 3 });
    expect(applyReverseSuggestion('/choose/7', params(''), take)).toBe('/choose/7?era=E2&scene=3');
    expect(take).toHaveBeenCalledTimes(1);
  });

  it('保留 URL 上的张数', () => {
    expect(
      applyReverseSuggestion('/choose/7', params('count=3'), taker({ eraCode: 'E4', sceneId: 5 })),
    ).toBe('/choose/7?era=E4&scene=5&count=3');
  });

  it('URL 已带 era / scene → 不消费推荐、不动 URL（用户手选优先）', () => {
    for (const query of ['era=E1', 'scene=2', 'era=E1&scene=2']) {
      const take = taker({ eraCode: 'E2', sceneId: 3 });
      expect(applyReverseSuggestion('/choose/7', params(query), take), query).toBeNull();
      expect(take, query).not.toHaveBeenCalled();
    }
  });

  it('没有推荐 / 推荐两个值都为空 → null', () => {
    expect(applyReverseSuggestion('/choose/7', params(''), taker(null))).toBeNull();
    expect(applyReverseSuggestion('/choose/7', params(''), taker({ eraCode: null, sceneId: null }))).toBeNull();
  });

  it('只有一个推荐值也写进 URL', () => {
    expect(applyReverseSuggestion('/choose/7', params(''), taker({ eraCode: 'E3', sceneId: null }))).toBe(
      '/choose/7?era=E3',
    );
  });
});
