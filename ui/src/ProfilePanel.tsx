import { useEffect, useRef, useState } from 'react';
import { askText } from './dialog';
import type { Profile } from '../../src/domain/schema';
import { api } from './api';
type Metadata = { profileId: string; name: string; archived: boolean };
export function ProfilePanel() {
  const revision = useRef<string | undefined>(undefined);
  const [profiles, setProfiles] = useState<Metadata[]>([]), [profile, setProfile] = useState<Profile | null>(null);
  const [versions, setVersions] = useState<number[]>([]), [skills, setSkills] = useState('[]'), [defaults, setDefaults] = useState('{}');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [id, setId] = useState(''), [name, setName] = useState(''), [template, setTemplate] = useState('implementer');
  async function refresh() { setProfiles((await api<{ profiles: Metadata[] }>('/api/profiles')).profiles); }
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, []);
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function open(profileId: string) {
    const result = await api<{ draft: Profile; revision: string }>(`/api/profiles/${encodeURIComponent(profileId)}/draft`);
    revision.current = result.revision; setProfile(result.draft); setSkills(JSON.stringify(result.draft.skills, null, 2)); setDefaults(JSON.stringify(result.draft.outputDefaults, null, 2));
    setVersions((await api<{ versions: number[] }>(`/api/profiles/${encodeURIComponent(profileId)}/versions`)).versions);
  }
  async function save() {
    if (!profile) return;
    const saved = await api<{ revision: string }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/draft`, 'PUT', { draft: { ...profile, skills: JSON.parse(skills), outputDefaults: JSON.parse(defaults) }, ...(revision.current ? { expectedRevision: revision.current } : {}) });
    revision.current = saved.revision; return saved.revision;
  }
  const metadata = profiles.find(item => item.profileId === profile?.profileId);
  return <section className="runs-page"><div className="page-heading"><div><h1>Agent profiles</h1><p>Tái sử dụng hướng dẫn, skills và giới hạn quyền giữa các flow.</p></div></div>
    {error && <div className="alert error" role="alert">{error}</div>}{message && <div className="alert success">{message}</div>}
    <div className="runs-layout"><aside className="runs-history"><h3>Profiles của project</h3>{profiles.map(item => <button key={item.profileId} className={`run-history-item ${profile?.profileId === item.profileId ? 'selected' : ''}`} onClick={() => void action(() => open(item.profileId))}><strong>{item.name}</strong><small>{item.profileId}{item.archived ? ' · đã lưu trữ' : ''}</small></button>)}<p className="run-note">Implementer và Verifier có bản mặc định dùng chung. Tạo profile cùng ID nếu bạn muốn quản lý phiên bản riêng trong project.</p></aside>
    <div className="run-content"><form className="run-card" onSubmit={e => { e.preventDefault(); void action(async () => {
      await api('/api/profiles', 'POST', { id, name, template }); await open(id); setId(''); setName('');
    }); }}><h3>Tạo profile</h3><label>Profile ID<input required value={id} onChange={e => setId(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" /></label><label>Tên<input required value={name} onChange={e => setName(e.target.value)} /></label><label>Mẫu<select aria-label="Mẫu profile" value={template} onChange={e => setTemplate(e.target.value)}><option value="implementer">Implementer</option><option value="verifier">Verifier · chỉ đọc</option></select></label><button className="secondary-btn" disabled={busy}>Tạo bản nháp</button></form>
      {profile && <div className="run-card"><h2>{metadata?.name ?? profile.name}</h2><p>Phiên bản đã lưu: {versions.join(', ') || 'chưa có'}. Run đã bắt đầu giữ snapshot cũ.</p>
        <label>Hướng dẫn<textarea aria-label="Hướng dẫn" rows={8} value={profile.instructions} onChange={e => setProfile({ ...profile, instructions: e.target.value })} /></label>
        <h3>Quyền tối đa của profile</h3>{(['read', 'write', 'checks', 'gitCommit'] as const).map(permission => <label className="profile-permission" key={permission}><input type="checkbox" checked={profile.requestedPermissions[permission]} onChange={e => setProfile({ ...profile, requestedPermissions: { ...profile.requestedPermissions, [permission]: e.target.checked } })} />{({ read: 'Đọc', write: 'Sửa file', checks: 'Chạy checks', gitCommit: 'Commit local' })[permission]}</label>)}
        <label>Skills (JSON)<textarea aria-label="Skills (JSON)" rows={5} value={skills} onChange={e => setSkills(e.target.value)} /></label><p className="run-note">Mỗi skill có id, path tương đối với project và sha256. Nội dung được ghim khi bắt đầu run.</p>
        <details><summary>Output defaults</summary><textarea aria-label="Output defaults" rows={4} value={defaults} onChange={e => setDefaults(e.target.value)} /></details>
        <div className="run-controls"><button className="secondary-btn" disabled={busy} onClick={() => void action(async () => { await save(); setMessage('Đã lưu nháp'); })}>Lưu nháp</button><button className="primary-btn" disabled={busy || metadata?.archived} onClick={() => void action(async () => { const expectedRevision = await save(); const result = await api<{ version: { version: number } }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/publish`, 'POST', { expectedRevision }); setMessage(`Đã lưu phiên bản ${result.version.version}`); await open(profile.profileId); })}>Lưu phiên bản</button>
          <button className="quiet-btn" disabled={busy} onClick={() => void askText('Tên mới', metadata?.name).then(value => { if (value) void action(async () => { await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/rename`, 'POST', { name: value }); }); })}>Đổi tên</button>
          <button className="quiet-btn" disabled={busy} onClick={() => void askText('ID profile bản sao').then(targetId => { if (targetId) void action(async () => { await save(); await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/clone`, 'POST', { targetId, name: `${metadata?.name ?? profile.name} copy` }); await open(targetId); }); })}>Sao chép</button>
          <button className="quiet-btn" disabled={busy} onClick={() => void action(async () => { await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/${metadata?.archived ? 'restore' : 'archive'}`, 'POST'); })}>{metadata?.archived ? 'Khôi phục' : 'Lưu trữ'}</button>
          <button className="quiet-btn" disabled={busy} onClick={() => void askText(`Nhập chính xác tên để xóa profile: ${metadata?.name}`).then(confirmedName => { if (confirmedName) void action(async () => { await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/delete`, 'POST', { confirmedName }); setProfile(null); }); })}>Xóa vĩnh viễn</button></div>
      </div>}
    </div></div>
  </section>;
}
