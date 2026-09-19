import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../domain/errors';
import { resetArk } from '../ark';
import {
  buildEraCheckPrompt,
  eraReview,
  midOfRange,
  normalizeEraCheck,
} from './eraReview';
/**
 * 年代复核与年龄偏差的**纯函数 + 回放**单元测试（`docs/prd/modules/M07-生成后复核与内容审核.md`
 * §5.2、§5.4、§8）：`ERA-01` 的归一化与 `ERA-02` 的算术都在这里断言。
 * handler 层「复核失败不阻断」「判定只标注」见 `src/jobs/handlers/generate.test.ts`。
 */
beforeAll(() => {
  process.env.PROVIDER = 'mock';
  resetArk();
});

afterAll(() => {
  delete process.env.PROVIDER;
  resetArk();
});

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'NO_THROW';
  } catch (err) {
    return err instanceof AppError ? err.code : `NON_APP_ERROR:${String(err)}`;
  }
};

describe('midOfRange（modules/M07 §5.4）', () => {
  it('"75-85岁" → 80、`"70-78"` → 74；四舍五入', () => {
    expect(midOfRange('75-85岁')).toBe(80);
    expect(midOfRange('70-78')).toBe(74);
    expect(midOfRange('71-78')).toBe(75); // 74.5 → 75
  });

  it('不可解析（少于两个整数 / null）→ null', () => {
    expect(midOfRange('不详')).toBeNull();
    expect(midOfRange('约 70 岁上下')).toBeNull();
    expect(midOfRange(null)).toBeNull();
  });
});

describe('normalizeEraCheck 的归一（modules/M07 §5.2、§8）', () => {
  it('落库键集合恒为 {passed, verdict, findings, model}，estimatedAgeRange 消费后丢弃', () => {
    const { eraCheck, estimatedAgeRange } = normalizeEraCheck(
      JSON.stringify({ verdict: 'review', findings: [{ item: '智能手机', reason: '晚于所选年代' }], estimatedAgeRange: '66-74' }),
      'doubao-seed-2-1',
    );
    expect(Object.keys(eraCheck).sort()).toEqual(['findings', 'model', 'passed', 'verdict']);
    expect(eraCheck).toEqual({
      passed: false,
      verdict: 'review',
      findings: [{ item: '智能手机', reason: '晚于所选年代' }],
      model: 'doubao-seed-2-1',
    });
    expect(estimatedAgeRange).toBe('66-74');
  });

  it('verdict=pass 但 findings 非空 → 提升为 review（passed=false）', () => {
    const { eraCheck } = normalizeEraCheck(
      JSON.stringify({ verdict: 'pass', findings: [{ item: '现代汽车外观', reason: '车身晚于所选年代' }] }),
      null,
    );
    expect(eraCheck.verdict).toBe('review');
    expect(eraCheck.passed).toBe(false);
  });

  it('verdict 非枚举值或缺失 → 按 findings 推导（空 → pass，非空 → review）', () => {
    expect(normalizeEraCheck(JSON.stringify({ verdict: 'weird', findings: [] }), null).eraCheck.verdict).toBe('pass');
    expect(
      normalizeEraCheck(JSON.stringify({ findings: [{ item: '玻璃幕墙', reason: '晚于年代' }] }), null).eraCheck.verdict,
    ).toBe('review');
  });

  it('findings 超 5 条截断、非字符串条目丢弃、无发现即空数组', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ item: `物件${i}`, reason: '理由' }));
    const { eraCheck } = normalizeEraCheck(
      JSON.stringify({ verdict: 'reject', findings: [...many, { item: 3, reason: 'x' }, { item: 'a' }] }),
      null,
    );
    expect(eraCheck.findings).toHaveLength(5);
    expect(eraCheck.findings.map((f) => f.item)).toEqual(['物件0', '物件1', '物件2', '物件3', '物件4']);
    expect(normalizeEraCheck(JSON.stringify({ verdict: 'pass', findings: [] }), null).eraCheck.findings).toEqual([]);
  });

  it('剥 ```json 包裹；非 JSON / 非对象 → PROVIDER_ERROR', async () => {
    const fenced = '```json\n{ "verdict": "pass", "findings": [] }\n```';
    expect(normalizeEraCheck(fenced, null).eraCheck.verdict).toBe('pass');
    expect(await codeOf(async () => normalizeEraCheck('不是 JSON', null))).toBe('PROVIDER_ERROR');
    expect(await codeOf(async () => normalizeEraCheck('[1,2]', null))).toBe('PROVIDER_ERROR');
  });
});

describe('eraReview 的年龄偏差（ERA-02，modules/M07 §5.4）', () => {
  const review = (eraCode: string, sceneId: number, anchorAgeRange: string | null) =>
    eraReview({
      image: 'data:image/png;base64,AAAA',
      eraCode,
      sceneId,
      eraName: '测试年代',
      constraintPack: '测试口径：必须属于该年代或更早',
      anchorAgeRange,
    });

  it('默认样本（clean）：estimatedAgeRange 为 null → 回填锚点区间，age_delta = 0', async () => {
    const { eraCheck, ageDelta } = await review('E4', 9, '70-80岁');
    expect(eraCheck.verdict).toBe('pass');
    expect(ageDelta).toBe(0);
  });

  it('E2×S3 命中 review 样本：结果侧中值 70 − 锚点中值 75 = −5（负数 = 变年轻，不取绝对值）', async () => {
    const { eraCheck, ageDelta } = await review('E2', 3, '70-80岁');
    expect(eraCheck.verdict).toBe('review');
    expect(eraCheck.findings).toHaveLength(1);
    expect(ageDelta).toBe(-5);
  });

  it('任一侧不可解析 → age_delta = NULL', async () => {
    expect((await review('E2', 3, '不详')).ageDelta).toBeNull();
    expect((await review('E2', 3, null)).ageDelta).toBeNull();
  });

  it('prompt 常量只在本文件持有，且含所选年代口径原文', () => {
    const prompt = buildEraCheckPrompt({ eraName: '八十年代', constraintPack: '限制包原文' });
    expect(prompt).toContain('八十年代');
    expect(prompt).toContain('限制包原文');
  });
});
