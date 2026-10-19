import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon, useTicker } from './components.js';
import { UnitThumb } from './gameComponents.js';
import { store, useStore, loadPref, savePref } from '../store.js';
import { net } from '../net.js';
import { battleRunner } from '../battle/runner.js';
import { t, N_ } from '../../../shared/i18n.js';

const TYPES = [{ id: 'phys', label: N_('物理') }, { id: 'arts', label: N_('法术') },
  { id: 'true', label: N_('真实') }, { id: 'elemental', label: N_('元素') }];
const number = (n) => Math.round(n || 0).toLocaleString('zh-CN');
const rate = (n) => (n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
export function teamMetrics(snapshot, scope = 'battle', kind = null) {
  return (scope === 'battle' ? (kind && snapshot?.combatStages ? snapshot.combatStages[kind] : snapshot?.combat) : snapshot?.combatMatch) || { rows: [], damage: 0, healing: 0 };
}
const stageFor = (phase) => ({ UNITE: 'unite', FINAL_ASSAULT: 'boss', HIDDEN_CORE: 'hidden' })[phase] || 'normal';
const STAGES = [['normal', N_('个人战斗')], ['unite', N_('联防')], ['boss', N_('首领战')], ['hidden', N_('隐藏首领')]];
/** Expanded existing combat panel: one column per player, independent of the watched field. */
export function CombatMetricsPanel({ onClose }) {
  const pub = useStore((s) => s.match.public);
  const myId = useStore((s) => s.me.playerId);
  const [scope, setScope] = useState('battle');
  const [kind, setKind] = useState(() => stageFor(pub?.phase));
  useEffect(() => { setKind(stageFor(pub?.phase)); }, [pub?.round, pub?.phase]);
  const intervals = [500, 1000, 2000, 3000, 5000, 10000];
  const [intervalMs, setIntervalMs] = useState(() => {
    const saved = loadPref('combatMetricsInterval', 1000);
    return intervals.includes(saved) ? saved : 1000;
  });
  const [snapshot, setSnapshot] = useState(null);
  useTicker(250);
  useEffect(() => {
    let pending = false;
    const off = net.on('b.metrics', (m) => {
      if (m.round === store.get().match.public?.round) setSnapshot(m);
    });
    const poll = () => {
      if (pending || document.hidden || net.status !== 'online') return;
      pending = true;
      void net.request('b.metrics').catch(() => {}).finally(() => { pending = false; });
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    document.addEventListener('visibilitychange', poll);
    return () => { clearInterval(timer); off(); document.removeEventListener('visibilitychange', poll); };
  }, [intervalMs, pub?.round]);
  const closeRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, []);
  const result = teamMetrics(snapshot?.round === pub?.round ? snapshot : null, scope, kind);
  const own = myId && battleRunner?.combatMetrics({ scope: scope === 'match' ? 'match' : 'round', round: pub?.round, ownerId: myId, kind: scope === 'battle' ? kind : null });
  const remoteOwn = result.rows.filter((r) => r.ownerId === myId);
  const rows = own?.authoritative && own.rows.length && Math.max(...own.rows.map((r) => r.seconds)) >= Math.max(0, ...remoteOwn.map((r) => r.seconds))
    ? [...result.rows.filter((r) => r.ownerId !== myId), ...own.rows] : result.rows;
  const players = pub?.players || [];
  return html`<section id="combat-metrics-panel" class="combat-metrics combat-metrics--team brackets" role="dialog" aria-label=${t('作战统计')}
      onKeyDown=${(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation(); }}>
    <header class="combat-metrics__head">
      <div><span class="combat-metrics__micro">COMBAT ANALYSIS</span><h2>${t('作战统计')}</h2></div>
      <button ref=${closeRef} type="button" class="combat-metrics__close" aria-label=${t('关闭作战统计')} onClick=${onClose}><${Icon} name="close" /></button>
      <div class="combat-metrics__tools"><div class="combat-metrics__scopes" role="group" aria-label=${t('统计范围')}>
        ${[['battle', t('当前战斗')], ['match', t('本局累计')]].map(([id, label]) => html`<button type="button" key=${id} aria-pressed=${scope === id} onClick=${() => setScope(id)}>${label}</button>`)}
      </div></div>
      ${scope === 'battle' ? html`<div class="combat-metrics__scopes" role="group" aria-label=${t('战斗阶段')}>
        ${STAGES.filter(([id]) => id === kind || (id === 'normal' || id === 'unite') && !['FINAL_ASSAULT', 'HIDDEN_CORE'].includes(pub?.phase)
          || snapshot?.combatStages?.[id]?.rows.length).map(([id, label]) => html`<button type="button" key=${id} aria-pressed=${kind === id} onClick=${() => setKind(id)}>${t(label)}</button>`)}
      </div>` : null}
      <label class="combat-metrics__frequency">${t('队友数据更新间隔：{seconds} 秒', { seconds: intervalMs / 1000 })}
        <input type="range" min="0" max="5" step="1" value=${intervals.indexOf(intervalMs)} aria-label=${t('队友数据更新间隔')}
          onInput=${(e) => { const v = intervals[Number(e.target.value)]; setIntervalMs(v); savePref('combatMetricsInterval', v); }} />
      </label>
    </header>
    <div class="combat-metrics__legend" aria-label=${t('伤害类型图例')}>
      ${TYPES.map((type) => html`<span key=${type.id} class=${`combat-metrics__type combat-metrics__type--${type.id}`}>${t(type.label)}</span>`)}
      <span class="combat-metrics__sort">${t('伤害降序')}</span>
    </div>
    <div class="combat-metrics__columns" style=${{ '--combat-players': Math.max(1, players.length) }}>
      ${players.map((p) => {
        const waiting = p.playerId !== myId && (scope === 'match' || snapshot?.combatKind === kind) && snapshot?.pendingPlayers?.includes(p.playerId);
        const playerRows = rows.filter((r) => r.ownerId === p.playerId);
        const maximum = Math.max(1, ...playerRows.map((r) => r.damage));
        return html`<section key=${p.playerId} class="combat-metrics__player" data-player-id=${p.playerId}>
          <h3>${p.name}</h3>
          ${waiting ? html`<p class="combat-metrics__empty">${t('等待该战场最新数据')}</p>` : null}
          <div class="combat-metrics__totals"><span>${t('总伤害')} <b>${number(playerRows.reduce((n, r) => n + r.damage, 0))}</b></span>
            <span>${t('总治疗')} <b>${number(playerRows.reduce((n, r) => n + r.healing, 0))}</b></span></div>
          <ol class="combat-metrics__list" tabindex="0" aria-label=${t('干员伤害排行')}>
            ${playerRows.length ? playerRows.map((r, i) => html`<li key=${r.key} class="combat-metrics__row">
              <span class="combat-metrics__rank">${i + 1}</span>
              <${UnitThumb} kind=${r.kind === 'token' ? 'token' : 'chess'} id=${r.defId} showTier=${false} size="sm" />
              <div class="combat-metrics__unit"><div class="combat-metrics__name"><b title=${r.name}>${r.name || r.defId}</b></div>
                <div class="combat-metrics__bar" role="img" aria-label=${t('总伤害')} title=${TYPES.map((x) => `${t(x.label)} ${number(r.types[x.id])}`).join(' / ')}>
                  ${TYPES.map((x) => html`<span key=${x.id} class=${`combat-metrics__segment combat-metrics__segment--${x.id}`} style=${{ width: `${(r.types[x.id] || 0) / maximum * 100}%` }}></span>`)}
                </div>
                <div class="combat-metrics__values"><span><small>${t('伤害')}</small><b>${number(r.damage)}</b></span>
                  <span><small>DPS</small><b>${rate(r.dps)}</b></span><span><small>${t('治疗')}</small><b>${number(r.healing)}</b></span><span><small>HPS</small><b>${rate(r.hps)}</b></span></div>
              </div>
            </li>`) : html`<li class="combat-metrics__empty">${t('开始战斗后实时显示干员数据')}</li>`}
          </ol>
        </section>`;
      })}
    </div>
    <p class="combat-metrics__note">${t('全队统计 · 同名干员合并 · 召唤物计入所属干员')}<br />${t('个人战斗与联防分别统计；本局累计包含全部战斗。按实际扣血与有效治疗统计，切换视角不会重复计算。')}</p>
  </section>`;
}
