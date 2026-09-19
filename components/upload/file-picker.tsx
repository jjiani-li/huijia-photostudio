'use client';

import { useRef } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { PICK_LABEL } from './uploads';

/**
 * 文件选择器（`docs/prd/pages/P01-上传与身份确认.md` §4.2）：原生 `<input type="file">` + 一个按钮，
 * 观感与全站一致、不引入第三方上传控件。
 *
 * **前端不预判大小与类型**：`accept` 只是给系统对话框的提示，是否合法由服务端回
 * `INVALID_FILE_TYPE` / `FILE_TOO_LARGE` 判定（`pages/P01` §3、`spec/03-接口契约.md` §3.2）。
 * 上限（5 张）也不在这里裁——超过 5 张的「未处理」清单要按**整批选择顺序**算，
 * 由容器用 `pickFiles()`（`src/shared/upload.ts`）统一处理（`pages/P01` §4.2）。
 */
export interface FilePickerProps {
  /** 允许多选（本页恒为 `true`，保留成 prop 以对齐 `pages/P01` §4.2 的组件树）。 */
  multiple: boolean;
  accept: string;
  disabled?: boolean;
  label?: string;
  /** 只回传用户这一次选中的文件，顺序即选择顺序。 */
  onPick: (files: File[]) => void;
}

export function FilePicker({
  multiple,
  accept,
  disabled = false,
  label = PICK_LABEL,
  onPick,
}: FilePickerProps): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ''; // 清空，同一个文件再选一次也能触发 change
    if (files.length > 0) onPick(files);
  };

  return (
    <div className="flex flex-col items-start gap-sm">
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept={accept}
        onChange={onChange}
        className="hidden"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className={
          disabled
            ? 'rounded-pill bg-primary-soft px-2xl py-md text-body text-ink-soft'
            : 'rounded-pill bg-primary px-2xl py-md text-body text-background'
        }
      >
        {label}
      </button>
    </div>
  );
}
