



export function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function matchesWarmRules(model, rules) {
    if (!model || !Array.isArray(rules) || rules.length === 0) return false;
    const m = String(model).toLowerCase();
    return rules.some((r) => r && m.includes(String(r).toLowerCase()));
}

export function messagesKey(messages) {
    return fnv1a(JSON.stringify(messages || [])) + ':' + (messages?.length ?? 0);
}



export class WarmupGate {
    constructor({ ttlMs = 180000, minChars = 2000 } = {}) {
        this.ttlMs = ttlMs;
        this.minChars = minChars;
        this.lastKey = null;
        this.lastAt = 0;
        this.inflight = new Set();
    }

    _hotHas(key) {
        if (this.lastKey !== key) return false;
        return Date.now() - this.lastAt <= this.ttlMs;
    }



    decide(model, messages, { enabled, warmupModels, exactModels }) {
        if (!enabled) return { warm: false, reason: 'disabled', key: null };

        if (Array.isArray(exactModels) && exactModels.length > 0) {
            if (!exactModels.includes(model)) return { warm: false, reason: 'model', key: null };
        } else if (!matchesWarmRules(model, warmupModels)) {
            return { warm: false, reason: 'model', key: null };
        }
        if (!Array.isArray(messages) || messages.length === 0) return { warm: false, reason: 'empty', key: null };
        const serialized = JSON.stringify(messages);
        if (serialized.length < this.minChars) return { warm: false, reason: 'short', key: null };

        const key = messagesKey(messages);
        if (this._hotHas(key)) return { warm: false, reason: 'hot', key: null };
        if (this.inflight.has(key)) return { warm: false, reason: 'dedup', key: null };
        return { warm: true, reason: 'cold', key };
    }


    begin(key) {
        if (this.inflight.has(key)) return false;
        this.inflight.add(key);
        return true;
    }

    end(key) {
        this.inflight.delete(key);
    }


    markWarmed(messages) {
        if (!Array.isArray(messages)) return;
        this.lastKey = messagesKey(messages);
        this.lastAt = Date.now();
    }
}
