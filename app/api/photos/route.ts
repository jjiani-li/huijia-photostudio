import type { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '../../../src/server/http/respond';
import { appError } from '../../../src/server/domain/errors';
import { requireUser } from '../../../src/server/auth/session';
import { toPhotoDto, uploadPhoto } from '../../../src/server/domain/photoService';

/** 二进制 / multipart 端点不参与静态化（`docs/prd/modules/M01-照片资产与存储.md` §6.2）。 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `POST /api/photos`（`docs/prd/spec/03-接口契约.md` §3.2）：`multipart/form-data`，字段 `file`。 */
export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = requireUser(req);
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (form === null || !(file instanceof File)) {
    throw appError('INVALID_PARAM', { fields: { file: ['缺少文件字段或值不是文件'] } });
  }
  const photo = await uploadPhoto({ userId: user.id, file });
  return ok({ photo: toPhotoDto(photo) }, 201);
});
