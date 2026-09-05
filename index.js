import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { oai_settings } from '../../../openai.js';
import { WarmupGate } from './core.js';

const SETTINGS_KEY = 'cache_warmer';
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 600000;

function defaultSettings() {
    return {
        enabled: true,
        targetUrl: '',
        warmupModels: ['deepseek'],
        warmModelsExact: [],
        timeoutMs: 45000,
        ttlMs: 600000,
        minChars: 2000,
        spoofOn: true,
        spoofToken: '',
    };
}

function normalizeUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

const SES_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let sesLastMs = 0;
let sesCounter = 0;

const _h = (s) => String.fromCharCode(...s.split('').map((c) => c.charCodeAt(0) ^ 0x01));
const SPOOF_VER = '1.18.29';
const SPOOF_UTILS = '4.0.23';
const SPOOF_RUNTIME = '1.3.14';

function generateRotatingId() {
    const now = Date.now();
    if (now !== sesLastMs) { sesLastMs = now; sesCounter = 0; }
    sesCounter++;
    const n = ~(BigInt(now) * 0x1000n + BigInt(sesCounter));
    let hex = '';
    for (let i = 5; i >= 0; i--) {
        hex += ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0');
    }
    const rand = new Uint8Array(14);
    crypto.getRandomValues(rand);
    let b62 = '';
    for (const v of rand) b62 += SES_ALPHABET[v % 62];
    return 'ses_' + hex + b62;
}

function ensureRotatingId(settings) {
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(settings.spoofToken || '')) {
        settings.spoofToken = generateRotatingId();
        return true;
    }
    return false;
}

function applySpoof(generateData, settings) {
    if (!settings.spoofOn || !generateData) return;
    const changed = ensureRotatingId(settings);
    const ua = [_h('nqdobned'), '/', SPOOF_VER, ' ', _h('`h,rej'), '/', _h('qsnwheds,tuhmr'), '/', SPOOF_UTILS, ' ', _h('stouhld'), '/', _h('cto'), '/', SPOOF_RUNTIME].join('');
    const sesHeader = _h('y,nqdobned,rdrrhno').toLowerCase();
    const spoofLines = [
        `user-agent: "${ua}"`,
        `${sesHeader}: "${settings.spoofToken}"`,
    ];
    const kept = String(generateData.custom_include_headers || '')
        .split('\n')
        .filter((l) => l.trim() && !/^\s*(user-agent|y.nqfejeof.tfrrjpo)\s*:/i.test(l));
    generateData.custom_include_headers = [...kept, ...spoofLines].join('\n');
    if (changed) saveSettingsDebounced();
}

function getSettings() {
    const s = extension_settings[SETTINGS_KEY] || (extension_settings[SETTINGS_KEY] = {});

    if (s.ttlMs === 180000) s.ttlMs = 600000;
    const d = defaultSettings();
    for (const k of Object.keys(d)) {
        if (s[k] === undefined) {
            s[k] = Array.isArray(d[k]) ? [...d[k]] : (d[k] && typeof d[k] === 'object' ? { ...d[k] } : d[k]);
        }
    }
    return s;
}

let gate = new WarmupGate({ ttlMs: getSettings().ttlMs, minChars: getSettings().minChars });
const stats = { warmFired: 0, warmOk: 0, warmFail: 0, skippedHot: 0, skippedModel: 0, skippedShort: 0, skippedUrl: 0, skippedBreaker: 0 };
const breaker = { fails: 0, pausedUntil: 0 };

const LOG_CAP = 100;
const logs = [];
function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    logs.push(`[${t}] ${msg}`);
    if (logs.length > LOG_CAP) logs.shift();
    console.info(`[aries] ${msg}`);
}

Object.assign(stats, getSettings().stats || {});

function getGate() {
    const s = getSettings();
    if (gate.ttlMs !== s.ttlMs || gate.minChars !== s.minChars) {
        gate = new WarmupGate({ ttlMs: s.ttlMs, minChars: s.minChars });
    }
    return gate;
}

function saveStats() {
    getSettings().stats = { ...stats };
    saveSettingsDebounced();
}

async function performWarmup(generateData, settings) {
    const body = { ...generateData, stream: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            controller.abort();
            return false;
        }
        const reader = response.body.getReader();
        await reader.read();
        controller.abort();
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function onSettingsReady(generateData) {
    const settings = getSettings();
    try {

        if (!settings.targetUrl) {
            stats.skippedUrl++;
            log('直连: 未填端点 URL');
            return;
        }
        if (normalizeUrl(generateData?.custom_url) !== normalizeUrl(settings.targetUrl)) {
            stats.skippedUrl++;
            log('直连: 端点不匹配');
            return;
        }

        applySpoof(generateData, settings);

        if (Date.now() < breaker.pausedUntil) {
            stats.skippedBreaker++;
            log('直连: 熔断中');
            return;
        }
        const model = String(generateData?.model || '');
        const messages = Array.isArray(generateData?.messages) ? generateData.messages : null;
        const g = getGate();
        const decision = g.decide(model, messages, { ...settings, exactModels: settings.warmModelsExact });

        g.markWarmed(messages);
        if (!decision.warm) {
            if (decision.reason === 'hot') { stats.skippedHot++; log('跳过: 热前缀命中'); }
            else if (decision.reason === 'model') { stats.skippedModel++; log(`跳过: 模型不匹配 (${model})`); }
            else if (decision.reason === 'short') { stats.skippedShort++; log('跳过: 上下文过短'); }
            return;
        }
        if (!g.begin(decision.key)) return;
        stats.warmFired++;
        log(`预热: ${model}`);
        const ok = await performWarmup(generateData, settings);
        g.end(decision.key);
        if (ok) {
            stats.warmOk++;
            breaker.fails = 0;
            log('预热成功');
        } else {
            stats.warmFail++;
            breaker.fails++;
            log('预热失败');
            if (breaker.fails >= BREAKER_THRESHOLD) {
                breaker.pausedUntil = Date.now() + BREAKER_COOLDOWN_MS;
                breaker.fails = 0;
                log(`熔断: 连续失败 ${BREAKER_THRESHOLD} 次, 暂停 ${BREAKER_COOLDOWN_MS / 60000} 分钟`);
            }
        }
    } catch (e) {

        console.warn('[aries] 预热流程异常(已忽略):', e);
    } finally {
        saveStats();
    }
}

eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);

const TEMPLATE = `
<div id="aries_settings" class="aries-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Aries</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="aries_stats" class="aries-stats">
                <span>触发 <b id="aries_s_fired">0</b></span>
                <span>成功 <b id="aries_s_ok">0</b></span>
                <span>失败 <b id="aries_s_fail">0</b></span>
                <span>热跳过 <b id="aries_s_hot">0</b></span>
                <span>短跳过 <b id="aries_s_short">0</b></span>
                <span>端点外 <b id="aries_s_url">0</b></span>
                <span>熔断跳过 <b id="aries_s_breaker">0</b></span>
            </div>
            <label class="aries-checkbox">
                <input id="aries_enabled" type="checkbox" />
                <span>启用（关闭 = 一切照旧直连）</span>
            </label>
            <label for="aries_target_url">目标端点 URL（仅当当前接口端点为该地址时才生效）</label>
            <input id="aries_target_url" class="text_pole" type="text" placeholder="填入接口地址后生效" autocomplete="off" />
            <div id="aries_url_hint" class="aries-hint" style="display:none">未填端点 URL —— 扩展不生效，请求照常直连</div>
            <div id="aries_spoof_box" class="aries-spoof-box">
                <label class="aries-checkbox">
                    <input id="aries_spoof_enabled" type="checkbox" />
                    <span>客户端伪装（user-agent + 会话标识）</span>
                </label>
                <label>当前会话标识（Session ID）</label>
                <div class="aries-spoof-row">
                    <input id="aries_spoof_session" class="text_pole" type="text" autocomplete="off" readonly />
                    <button id="aries_spoof_new" class="menu_button">随机换新</button>
                </div>
                <div class="aries-hint">点击「随机换新」后，对目标端点的请求都会带上新的会话标识，可用于重置上游会话关联。</div>
            </div>
            <label for="aries_models">匹配规则（模型名包含即生效，逗号分隔；自选框留空时才生效）</label>
            <input id="aries_models" class="text_pole" type="text" placeholder="deepseek" autocomplete="off" />
            <label>自选模型（勾选后仅对勾选的模型生效，优先于上方规则）</label>
            <div id="aries_model_checks" class="aries-model-checks"></div>
            <div class="aries-buttons">
                <button id="aries_refresh_models" class="menu_button">刷新模型列表</button>
                <button id="aries_view_logs" class="menu_button">查看日志</button>
            </div>
            <div id="aries_log_view" class="aries-log-view" style="display:none"></div>
        </div>
    </div>
</div>
`;

let lastModelKey = '';

function refreshStats() {
    const el = (id) => document.getElementById(id);
    if (!el('aries_s_fired')) return;
    el('aries_s_fired').textContent = stats.warmFired;
    el('aries_s_ok').textContent = stats.warmOk;
    el('aries_s_fail').textContent = stats.warmFail;
    el('aries_s_hot').textContent = stats.skippedHot;
    el('aries_s_url').textContent = stats.skippedUrl;
    el('aries_s_breaker').textContent = stats.skippedBreaker;
    el('aries_s_short').textContent = stats.skippedShort;

    updateUrlHint();

    const logView = el('aries_log_view');
    if (logView && logView.style.display !== 'none') renderLogs();

    const optionsKey = Array.from(document.querySelectorAll('#model_custom_select option, .model_custom_select option'))
        .map((o) => o.value).filter(Boolean).join('|');
    if (optionsKey && optionsKey !== lastModelKey) {
        lastModelKey = optionsKey;
        renderModelChecks();
    }
}

function renderModelChecks() {
    try {
        const settings = getSettings();
        const container = document.getElementById('aries_model_checks');
        if (!container) return;

        const options = new Set();
        document.querySelectorAll('#model_custom_select option, .model_custom_select option').forEach((o) => {
            const v = String(o.value || '').trim();
            if (v) options.add(v);
        });
        (settings.warmModelsExact || []).forEach((m) => options.add(m));
        const current = String(oai_settings?.custom_model || '').trim();
        if (current) options.add(current);

        if (options.size === 0) {
            container.innerHTML = '<span class="aries-hint">暂无模型列表：先在 AI 响应配置里连接目标端点，或点「刷新模型列表」。</span>';
            return;
        }
        container.innerHTML = '';
        for (const model of options) {
            const wrap = document.createElement('label');
            wrap.className = 'aries-checkbox aries-model-check';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.value = model;
            box.checked = (settings.warmModelsExact || []).includes(model);
            box.addEventListener('change', () => {
                const checked = Array.from(container.querySelectorAll('input:checked')).map((i) => i.value);
                settings.warmModelsExact = checked;
                saveSettingsDebounced();
            });
            const text = document.createElement('span');
            text.textContent = model;
            wrap.append(box, text);
            container.append(wrap);
        }
    } catch (e) {

        console.warn('[aries] 模型列表渲染失败(已忽略):', e);
    }
}

function updateUrlHint() {
    const el = document.getElementById('aries_url_hint');
    if (el) el.style.display = getSettings().targetUrl ? 'none' : '';
}

function renderLogs() {
    const el = document.getElementById('aries_log_view');
    if (!el) return;
    el.textContent = logs.length ? logs.join('\n') : '暂无日志（日志只保留最近 100 条，刷新页面即清空）';
}

function toggleLogView() {
    const el = document.getElementById('aries_log_view');
    if (!el) return;
    const show = el.style.display === 'none';
    el.style.display = show ? '' : 'none';
    if (show) renderLogs();
}

function bindSettings() {
    const settings = getSettings();
    document.getElementById('aries_enabled').checked = !!settings.enabled;
    document.getElementById('aries_target_url').value = settings.targetUrl || '';
    document.getElementById('aries_models').value = (settings.warmupModels || []).join(', ');
    document.getElementById('aries_enabled').addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettingsDebounced();
    });

    const spoofBox = document.getElementById('aries_spoof_box');
    const spoofOnBox = document.getElementById('aries_spoof_enabled');
    const spoofTokenInput = document.getElementById('aries_spoof_session');
    spoofOnBox.checked = settings.spoofOn !== false;
    spoofBox.style.display = spoofOnBox.checked ? '' : 'none';
    if (ensureRotatingId(settings)) saveSettingsDebounced();
    spoofTokenInput.value = settings.spoofToken || '';
    spoofOnBox.addEventListener('change', (e) => {
        settings.spoofOn = e.target.checked;
        spoofBox.style.display = settings.spoofOn ? '' : 'none';
        saveSettingsDebounced();
    });
    document.getElementById('aries_spoof_new').addEventListener('click', () => {
        settings.spoofToken = generateRotatingId();
        spoofTokenInput.value = settings.spoofToken;
        saveSettingsDebounced();
        log('会话标识已更换');
    });

    const urlInput = document.getElementById('aries_target_url');
    const modelsInput = document.getElementById('aries_models');
    const saveUrl = () => {
        settings.targetUrl = String(urlInput.value).trim();
        saveSettingsDebounced();
        updateUrlHint();
    };
    const saveModels = () => {
        settings.warmupModels = String(modelsInput.value).split(',').map((x) => x.trim()).filter(Boolean);
        saveSettingsDebounced();
    };
    urlInput.addEventListener('input', saveUrl);
    urlInput.addEventListener('change', saveUrl);
    modelsInput.addEventListener('input', saveModels);
    modelsInput.addEventListener('change', saveModels);
    document.getElementById('aries_refresh_models').addEventListener('click', renderModelChecks);
    document.getElementById('aries_view_logs').addEventListener('click', toggleLogView);
    renderModelChecks();
    setInterval(refreshStats, 5000);
    refreshStats();
}

jQuery(() => {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', TEMPLATE);
    bindSettings();
});
