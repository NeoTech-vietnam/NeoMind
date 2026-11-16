import { useEffect, useRef, useState } from 'react';
import { requestLangConfigPreview } from './api';
import { readLangConfigFile, safeLangConfigPreview } from './langconfig-preview-model';
import { Button } from './components/ui/button';
import { Dialog, DialogActions, DialogContent } from './components/ui/dialog';

export function LangConfigPreview({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [result, setResult] = useState<ReturnType<typeof safeLangConfigPreview>>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => { if (!open) { generation.current++; setResult(null); setError(''); setBusy(false); } }, [open]);
  useEffect(() => () => { generation.current++; }, []);
  const select = async (file: File) => {
    const current = ++generation.current;
    setResult(null); setError(''); setBusy(true);
    try {
      const text = await readLangConfigFile(file);
      if (current !== generation.current) return;
      const response = await requestLangConfigPreview(text);
      if (current !== generation.current) return;
      const safe = safeLangConfigPreview(response.body);
      if (safe && (response.status === 200 || response.status === 400 || response.status === 413)) setResult(safe);
      else setError(response.status === 413 ? 'File vượt giới hạn xử lý 1 MiB.' : 'Không thể xem trước. Hãy kiểm tra file và thử lại.');
    } catch (reason) {
      if (current !== generation.current) return;
      setError(reason instanceof Error && reason.message === 'size' ? 'File vượt giới hạn 1 MiB; chưa đọc nội dung.' : reason instanceof Error && reason.message === 'encoding' ? 'File không phải UTF-8 hợp lệ.' : 'Không thể xem trước. Hãy kiểm tra file và thử lại.');
    } finally { if (current === generation.current) setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent title="Xem trước workflow LangConfig" description="Chỉ xem gợi ý cấu trúc, không phải flow có thể chạy. Không lưu, nhập, publish hoặc chạy; nội dung file được gửi tới API NeoMind hiện tại." className="flex max-h-[85vh] w-[640px] flex-col">
    <div className="mt-4 min-h-0 overflow-auto text-[13px]">
      <label htmlFor="langconfig-preview-file" className="block font-medium">Chọn file .langconfig hoặc JSON (tối đa 1 MiB)</label>
      <input id="langconfig-preview-file" type="file" accept=".langconfig,.json,application/json" className="mt-2 block w-full text-[12px]" onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void select(file);
      }} />
      {busy && <p role="status">Đang xem trước…</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      {result && <section aria-label="Kết quả xem trước" aria-live="polite" className="mt-4 space-y-3">
        <p className="m-0">{result.source} · {result.nodes.length} bước · {result.edges.length} kết nối · {result.diagnostics.length} chẩn đoán</p>
        <div><h3 className="mb-1 font-semibold">Bước (ID tạm)</h3>{result.nodes.length ? <ul className="m-0 pl-5">{result.nodes.map(node => <li key={node.id}>{node.id} · {node.kind}</li>)}</ul> : <p>Không có bước để hiển thị.</p>}</div>
        {result.edges.length > 0 && <details><summary className="cursor-pointer font-semibold">Kết nối ({result.edges.length})</summary><ul className="pl-5">{result.edges.map((edge, index) => <li key={index}>{edge.from} → {edge.to}{edge.outcome}</li>)}</ul></details>}
        <div><h3 className="mb-1 font-semibold">Chẩn đoán</h3>{result.diagnostics.length ? <ul className="m-0 space-y-1 pl-5">{result.diagnostics.map((item, index) => <li key={index}><code>{item.location}</code> · {item.message}</li>)}</ul> : <p>Không có chẩn đoán.</p>}</div>
      </section>}
    </div>
    <DialogActions><Button onClick={() => onOpenChange(false)}>Đóng</Button></DialogActions>
  </DialogContent></Dialog>;
}
