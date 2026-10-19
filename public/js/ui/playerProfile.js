import { useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal } from './components.js';
import { store, useStore } from '../store.js';
import { exportPassport, importPassport, profileState, retryProfile } from '../profileSync.js';
import { t, N_ } from '../../../shared/i18n.js';

const labels = { idle: N_('登录后自动保存'), loading: N_('正在恢复玩家档案…'), saving: N_('正在保存玩家档案…'),
  saved: N_('玩家档案已保存到服务器'), conflict: N_('档案在另一页面已更新，请先导出本地资料再刷新。'), error: N_('档案同步失败，本地资料仍保留，请重试。') };
export function PlayerProfileButton() {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const state = useStore((s) => s, Object.is, profileState);
  const file = useRef(null);
  const run = async (fn) => { setBusy(true); setError(false); try { await fn(); } catch (e) { setError(e.code === 'passport-active' ? 'active' : true); } finally { setBusy(false); } };
  return html`<div class="player-profile">
    <${Button} size="sm" onClick=${() => setOpen(true)}>${t('玩家档案与通行证')}<//>
    <${Modal} open=${open} onClose=${() => setOpen(false)} title=${t('玩家档案与通行证')}>
      <p role="status">${t(labels[state.status] || labels.idle)}</p>
      ${state.playerId ? html`<p>${t('玩家 ID')} <code>${state.playerId}</code></p>` : null}
      <p>${t('调配、持有、自选编队、皮肤选择与对局记录自动保存到服主电脑。换网址后导入同一份通行证，即可恢复同一玩家 ID 和最新档案。')}</p>
      <p class="t-lo">${t('通行证包含身份密钥，请妥善保存，不要发到群里。同一身份同时只能在一个页面游戏。')}</p>
      <${Button} disabled=${busy || !state.playerId} onClick=${() => run(async () => {
        const p = await exportPassport();
        const url = URL.createObjectURL(new Blob([JSON.stringify(p)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = `Stronghold-${p.playerId}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>${t('导出玩家通行证')}<//>
      <${Button} disabled=${busy || !!store.get().room} onClick=${() => file.current?.click()}>${t('导入玩家通行证')}<//>
      <${Button} disabled=${busy} onClick=${() => run(retryProfile)}>${t('重试')}<//>
      <input ref=${file} type="file" accept=".json,application/json" hidden onChange=${(e) => {
        const chosen = e.target.files?.[0]; e.target.value = '';
        if (chosen) void run(async () => { if (chosen.size > 4 * 1024 * 1024) throw new Error('Too large'); await importPassport(JSON.parse(await chosen.text())); });
      }} />
      ${store.get().room ? html`<p>${t('切换通行证前请先离开同盟。')}</p>` : null}
      ${error ? html`<p role="alert">${error === 'active' ? t('请先关闭使用该通行证的旧游戏页面，再导入。') : t('操作失败，请检查通行证及网络连接后重试。')}</p>` : null}
    <//>
  </div>`;
}
