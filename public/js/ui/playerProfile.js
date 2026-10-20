import { useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal } from './components.js';
import { store, useStore } from '../store.js';
import { exportPassport, importPassport, profileState, retryProfile } from '../profileSync.js';
import { directoryState, directorySupported, chooseDirectory, syncDirectory, disconnectDirectory, importDirectoryAssets } from '../localDirectorySync.js';
import { t, N_ } from '../../../shared/i18n.js';

const labels = { idle: N_('登录后自动保存'), loading: N_('正在恢复玩家档案…'), saving: N_('正在保存玩家档案…'),
  saved: N_('玩家档案已保存到服务器'), conflict: N_('档案在另一页面已更新，请先导出本地资料再刷新。'), error: N_('档案同步失败，本地资料仍保留，请重试。') };
const directoryLabels = { off: N_('尚未连接本地目录'), permission: N_('请重新选择目录以授权读写'), ready: N_('目录已连接，登录后自动同步'),
  saving: N_('正在写入本地目录…'), saved: N_('本地档案已保存'), 'local-only': N_('本地已保存，服务器同步暂未完成'), error: N_('目录同步失败，请重新选择目录或重试') };
export function PlayerProfileButton() {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const state = useStore((s) => s, Object.is, profileState);
  const dir = useStore(s => s, Object.is, directoryState);
  const file = useRef(null), zip = useRef(null);
  const run = async (fn) => { setBusy(true); setError(false); try { await fn(); } catch (e) {
    if (e.name !== 'AbortError') setError(e.code === 'passport-active' ? 'active' : e.code === 'directory-conflict' ? 'conflict' : true);
  } finally { setBusy(false); } };
  return html`<div class="player-profile">
    <${Button} size="sm" onClick=${() => setOpen(true)}>${t('玩家档案与通行证')}<//>
    <${Modal} open=${open} onClose=${() => setOpen(false)} title=${t('玩家档案与通行证')} width="7.8rem"
      actions=${html`<${Button} onClick=${() => setOpen(false)}>${t('关闭')}<//>`}>
      <p role="status">${t(labels[state.status] || labels.idle)}</p>
      ${state.playerId ? html`<p>${t('玩家 ID')} <code>${state.playerId}</code></p>` : null}
      <p>${t('调配、持有、自选编队、皮肤选择与对局记录自动保存到服主电脑。换网址后导入同一份通行证，即可恢复同一玩家 ID 和最新档案。')}</p>
      <p class="t-lo">${t('通行证包含身份密钥，请妥善保存，不要发到群里。同一身份同时只能在一个页面游戏。')}</p>
      <section class="local-directory-sync">
        <h3>${t('本地目录同步')}</h3>
        <p>${t('选择自己的备份目录，换随机网址后再次选择同一目录，恢复同一玩家 ID、最新档案和已保存素材。目录内含身份密钥，每位玩家请使用自己的目录。')}</p>
        <p role="status" data-testid="directory-status">${t(directoryLabels[dir.status] || directoryLabels.off)} ${dir.name ? html`<code>${dir.name}/Stronghold-data</code>` : null}
          ${dir.at ? html` · ${new Date(dir.at).toLocaleTimeString()}` : null}</p>
        ${directorySupported() ? html`
          <${Button} disabled=${busy || !!store.get().room} onClick=${() => run(chooseDirectory)}>${t('选择／重新连接目录')}<//>
          <${Button} disabled=${busy || !dir.name || dir.status === 'permission' || !state.playerId} onClick=${() => run(syncDirectory)}>${t('立即同步')}<//>
          <${Button} disabled=${busy || !dir.name || !!dir.importing && dir.importing.phase === 'running'} onClick=${() => run(disconnectDirectory)}>${t('断开目录')}<//>
          <${Button} disabled=${busy || !dir.name || dir.status === 'permission'} onClick=${() => zip.current?.click()}>${t('将素材包保存到此目录')}<//>
          <input ref=${zip} type="file" accept=".zip,application/zip" hidden onChange=${e => {
            const chosen = e.target.files?.[0]; e.target.value = '';
            if (chosen) void run(() => importDirectoryAssets(chosen));
          }} />
          ${dir.importing ? html`<p role="status">${t('目录素材：已保存 {accepted}，处理 {done} / {total}', dir.importing)}</p>` : null}
          <p class="t-lo">${t('连接后，档案持续自动保存，素材按需下载并自动写入目录。已有 ZIP 可导入目录一次，此后换网址无需重复导入。退出前可点“立即同步”确认写入完成。')}</p>
          <p class="t-lo">${t('同一网址可记住已授权目录；新随机网址需要重新选择。目录连接失败不影响进入游戏。')}</p>
        ` : html`<p>${t('此浏览器不支持目录同步。请使用桌面 Chrome／Edge，或使用下方通行证与首页素材包导入。')}</p>`}
      </section>
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
        if (chosen) void run(async () => { if (chosen.size > 4 * 1024 * 1024) throw new Error('Too large'); const raw = JSON.parse(await chosen.text()); await disconnectDirectory(); await importPassport(raw); });
      }} />
      ${store.get().room ? html`<p>${t('切换通行证前请先离开同盟。')}</p>` : null}
      ${error || dir.error ? html`<p role="alert">${error === 'active' || dir.error === 'passport-active' ? t('请先关闭使用该通行证的旧游戏页面，再导入。')
        : error === 'conflict' || dir.error === 'directory-conflict' ? t('目录和服务器均有更新，已停止恢复以避免覆盖。请保留 player.json，先导入通行证恢复服务器档案；未同步的本地修改仍在目录中。')
          : t('操作失败，请检查通行证及网络连接后重试。')}</p>` : null}
    <//>
  </div>`;
}
