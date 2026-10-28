/* ============================================================
 * recommender.js — 推荐算法与在线歌曲 API
 * ----------------------------------------------------------------
 * 1. 情绪空间: Russell 效价-唤醒度 (Valence-Arousal) 环状模型
 * 2. 推荐得分 = 0.40*VA匹配 + 0.35*标签匹配 + 0.15*律动匹配 + 0.10*个性化反馈 (+ ε 探索)
 * 3. 个性化: 用户对歌曲的 喜欢/跳过 反馈构成轻量 Contextual-Bandit
 * 4. 在线接口: iTunes Search API (JSONP, 免密钥, 支持 CORS 代理回退)
 * ============================================================ */
const Recommender = (() => {

  /* 7 类基本情绪的 (效价V, 唤醒A) 原型坐标 */
  const PROTO = {
    happy:     { v: 0.75, a: 0.72 }, surprised: { v: 0.35, a: 0.82 },
    neutral:   { v: 0.10, a: 0.30 }, disgusted: { v: -0.55, a: 0.18 },
    sad:       { v: -0.72, a: -0.45 }, fearful:  { v: -0.62, a: 0.55 },
    angry:     { v: -0.58, a: 0.88 }
  };
  /* 情绪相邻度矩阵 (Plutchik 情绪轮), 未列出默认 0.3 */
  const ADJ = {
    'happy|surprised': .55, 'happy|neutral': .45, 'sad|fearful': .60, 'sad|disgusted': .45,
    'angry|disgusted': .60, 'angry|fearful': .55, 'fearful|surprised': .50, 'sad|angry': .40
  };
  const adj = (a, b) => a === b ? 1 : (ADJ[`${a}|${b}`] ?? ADJ[`${b}|${a}`] ?? 0.30);

  /* 各情绪对应的在线搜索关键词 */
  const QUERY = {
    happy: ['happy upbeat pop', '欢乐', 'feel good'], sad: ['sad ballad', 'sad piano', 'melancholy'],
    angry: ['rock intense', 'angry rock', 'heavy'], fearful: ['epic tension instrumental', 'dark ambient', 'suspense'],
    surprised: ['electronic energic', 'edm fun', 'bright electro'], disgusted: ['grunge alternative', 'moody indie', 'alternative dark'],
    neutral: ['lofi chill', 'acoustic calm', 'chill instrumental']
  };

  const clamp01 = x => Math.max(0, Math.min(1, x));

  /* 单曲与目标情绪的匹配得分 */
  function scoreTrack(track, emo, feedback) {
    const p = PROTO[emo] || PROTO.neutral;
    const dVA = Math.hypot(track.valence - p.v, track.arousal - p.a);      // 0~2
    const fVA = Math.exp(-1.8 * dVA * dVA);                                 // VA 高斯核匹配度
    const fLabel = adj(track.cls || track.target, emo);                     // 情绪标签相邻度(算法推导类别)
    const bpmN = clamp01((track.bpm - 55) / 125);
    const fRhythm = 1 - Math.abs(bpmN - (p.a + 1) / 2);                     // 律动-唤醒匹配
    const fb = (feedback && feedback[track.id]) || 0;                       // 喜欢+1 / 跳过-1
    const explore = (Math.random() - 0.5) * 0.04;                           // ε 探索扰动
    const score = 0.40 * fVA + 0.35 * fLabel + 0.15 * fRhythm + 0.10 * clamp01(0.5 + 0.5 * fb) + explore;
    return {
      score: Math.round(clamp01(score) * 1000) / 1000, fVA: +fVA.toFixed(3), fLabel, fRhythm: +fRhythm.toFixed(3),
      dVA: +dVA.toFixed(2)
    };
  }

  function recommend(tracks, emo, feedback, topN = 6) {
    return tracks
      .map(t => ({ ...t, match: scoreTrack(t, emo, feedback) }))
      .sort((a, b) => b.match.score - a.match.score)
      .slice(0, topN);
  }

  /* ---------- iTunes Search API (JSONP) ---------- */
  function jsonp(url, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const cb = '_emoCb' + Math.random().toString(36).slice(2);
      const s = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); reject(new Error('请求超时')); }, timeout);
      function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
      window[cb] = data => { cleanup(); resolve(data); };
      s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
      s.onerror = () => { cleanup(); reject(new Error('网络请求失败')); };
      document.head.appendChild(s);
    });
  }

  async function searchOnline(emo, limit = 8) {
    const terms = QUERY[emo] || QUERY.neutral;
    const term = terms[Math.floor(Math.random() * terms.length)];
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}`
      + `&media=music&entity=song&limit=${limit * 3}`;
    const data = await jsonp(url);
    const seen = new Set(); const out = [];
    for (const r of (data.results || [])) {
      if (!r.previewUrl || seen.has(r.trackId)) continue;
      seen.add(r.trackId);
      out.push({
        id: 'it-' + r.trackId, title: r.trackName, artist: r.artistName,
        file: r.previewUrl, artwork: (r.artworkUrl100 || '').replace('100x100', '200x200'),
        online: true, target: emo, previewMs: 30000
      });
      if (out.length >= limit) break;
    }
    return { term, songs: out };
  }

  return { PROTO, ADJ, scoreTrack, recommend, searchOnline };
})();
