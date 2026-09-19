import { describe, expect, it } from 'vitest';
import { CONSENT_SCOPES, type AnchorFeatures, type ConsentScope } from '../../src/shared/types';
import {
  allConsentsChecked,
  chooseHref,
  confirmHref,
  consentScopes,
  CONSENT_COPY,
  EXTRACT_STEPS,
  FEATURE_LABELS,
  FEATURE_TOGGLE_COPY,
  invalidConsentScopes,
  isTerminalAnchor,
  PHOTO_PENDING_COPY,
  UNCHECKED_CONSENTS,
} from './confirm-logic';

/**
 * `/confirm/[anchorId]` 的纯逻辑（`docs/prd/pages/P01-上传与身份确认.md` §4.3、
 * `docs/prd/modules/M04-身份确认与授权.md` §10、`docs/prd/spec/03-接口契约.md` §2.1）：
 * 勾选态、缺失项高亮、终止状态判据与路由，不依赖 React / 网络。
 */

const checked = (over: Partial<Record<ConsentScope, boolean>> = {}): Record<ConsentScope, boolean> => ({
  ...UNCHECKED_CONSENTS,
  ...over,
});

describe('逐字文案与顺序（§4.3、M04 §10）', () => {
  it('三步步骤提示逐字且有序', () => {
    expect(EXTRACT_STEPS).toEqual(['正在读取照片', '正在辨认脸部特征', '正在整理成文字']);
  });

  it('两项授权文案逐字，键序与 `CONSENT_SCOPES` 一致', () => {
    expect(CONSENT_COPY.photo_usage).toBe('我确认我手上有这张照片的使用权，也确认照片里的人是我认识的人。');
    expect(CONSENT_COPY.family_agreement).toBe('我已经和家里其他亲属说过这件事，他们同意我用这张照片来做。');
    expect(Object.keys(CONSENT_COPY)).toEqual([...CONSENT_SCOPES]);
  });

  it('12 项特征标签按 `AnchorFeatures` 键序一一对应，恰好 12 项', () => {
    const sample: AnchorFeatures = {
      gender: '男',
      ageRange: '中年',
      hair: '短发',
      faceShape: '方脸',
      forehead: '宽',
      eyebrows: '浓',
      eyes: '双眼皮',
      nose: '挺',
      mouth: '厚唇',
      skin: '偏黑',
      distinctive: '左边有痣',
      build: '偏瘦',
    };
    expect(FEATURE_LABELS.map((item) => item.key)).toEqual([
      'gender',
      'ageRange',
      'hair',
      'faceShape',
      'forehead',
      'eyebrows',
      'eyes',
      'nose',
      'mouth',
      'skin',
      'distinctive',
      'build',
    ]);
    expect(FEATURE_LABELS).toHaveLength(12);
    expect(FEATURE_LABELS.map((item) => item.key).slice().sort()).toEqual(Object.keys(sample).sort());
    expect(FEATURE_LABELS.map((item) => item.label)).toEqual([
      '性别',
      '年龄段',
      '发型',
      '脸型',
      '额头',
      '眉毛',
      '眼睛',
      '鼻子',
      '嘴部',
      '皮肤',
      '显著特征',
      '体型',
    ]);
  });

  it('折叠标题两态逐字', () => {
    expect(FEATURE_TOGGLE_COPY.collapsed).toBe('他长这样（12 项特征）');
    expect(FEATURE_TOGGLE_COPY.expanded).toBe('收起');
  });

  it('右侧占位文案逐字', () => {
    expect(PHOTO_PENDING_COPY).toBe('照片还在处理');
  });

  it('初始勾选态两项都未勾选（不得预勾选）', () => {
    expect(UNCHECKED_CONSENTS).toEqual({ photo_usage: false, family_agreement: false });
  });
});

describe('勾选态与提交载荷（M04 §10）', () => {
  it('只有两项都勾上才可提交', () => {
    expect(allConsentsChecked(checked())).toBe(false);
    expect(allConsentsChecked(checked({ photo_usage: true }))).toBe(false);
    expect(allConsentsChecked(checked({ family_agreement: true }))).toBe(false);
    expect(allConsentsChecked(checked({ photo_usage: true, family_agreement: true }))).toBe(true);
  });

  it('`consents` 只含勾上的项，顺序与文案顺序一致', () => {
    expect(consentScopes(checked())).toEqual([]);
    expect(consentScopes(checked({ family_agreement: true }))).toEqual(['family_agreement']);
    expect(consentScopes(checked({ photo_usage: true, family_agreement: true }))).toEqual([...CONSENT_SCOPES]);
  });
});

describe('`INVALID_PARAM` 的勾选项高亮（P00 §8）', () => {
  it('`details.fields.consents` 只高亮缺失项', () => {
    expect(invalidConsentScopes({ fields: { consents: ['family_agreement'] } })).toEqual(['family_agreement']);
    expect(invalidConsentScopes({ fields: { consents: ['photo_usage'] } })).toEqual(['photo_usage']);
  });

  it('拿不到具体缺失项（无 details / 空数组 / 非 consents 字段）时按两项都缺处理', () => {
    expect(invalidConsentScopes(undefined)).toEqual([...CONSENT_SCOPES]);
    expect(invalidConsentScopes({})).toEqual([...CONSENT_SCOPES]);
    expect(invalidConsentScopes({ fields: {} })).toEqual([...CONSENT_SCOPES]);
    expect(invalidConsentScopes({ fields: { consents: [] } })).toEqual([...CONSENT_SCOPES]);
    expect(invalidConsentScopes({ fields: { confirmed: ['x'] } })).toEqual([...CONSENT_SCOPES]);
  });

  it('认不出的 scope 值被忽略', () => {
    expect(invalidConsentScopes({ fields: { consents: ['not_a_scope'] } })).toEqual([...CONSENT_SCOPES]);
    expect(invalidConsentScopes({ fields: { consents: ['not_a_scope', 'photo_usage'] } })).toEqual(['photo_usage']);
  });
});

describe('终止状态与路由（spec/03 §2.1、P01 §4.3）', () => {
  it('终态只有 `succeeded` / `failed`', () => {
    expect(isTerminalAnchor('succeeded')).toBe(true);
    expect(isTerminalAnchor('failed')).toBe(true);
    expect(isTerminalAnchor('queued')).toBe(false);
    expect(isTerminalAnchor('running')).toBe(false);
  });

  it('确认成功跳 `/choose/:id`，retry 换到新 `/confirm/:id`', () => {
    expect(chooseHref(7)).toBe('/choose/7');
    expect(confirmHref(7)).toBe('/confirm/7');
    expect(confirmHref(8)).not.toBe(confirmHref(7));
  });
});
