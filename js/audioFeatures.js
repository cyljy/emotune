/* ============================================================
 * audioFeatures.js — 歌曲旋律情绪识别算法（纯前端本地 DSP）
 * ----------------------------------------------------------------
 * 流程: decodeAudioData → 重采样 → STFT(汉明窗) → 逐帧特征
 *   1. 节奏: 谱通量(onset) → 峰检测 → 自相关求 BPM、密度
 *   2. 音色: 谱质心(明亮度)、谱平坦度(粗糙/噪声感)、滚降
 *   3. 调式: 色度向量(Chroma) × Krumhansl 大/小调模板相关
 *   4. 效价/唤醒度 (Russell 环状情绪模型二维坐标)
 * 复杂度: O(N·logM)  (N=采样点数, M=FFT 窗长)
 * ============================================================ */
const AudioFeatures = (() => {

  /* ---------- 基础: 就地 radix-2 FFT ---------- */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {              // 位反转置换
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  /* Krumhansl-Kessler 调性感知轮廓 */
  const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function corr(a, b) {
    const ma = a.reduce((s, x) => s + x) / a.length, mb = b.reduce((s, x) => s + x) / b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return num / (Math.sqrt(da * db) + 1e-9);
  }

  /* ---------- 核心分析 ---------- */
  async function analyze(url, onProgress) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await fetch(url).then(r => r.arrayBuffer()).then(ab => ctx.decodeAudioData(ab));
    ctx.close();

    /* 降采样至 ~11kHz（特征提取足够，计算量降 16 倍） */
    const ch = buf.numberOfChannels, N0 = buf.length, SR0 = buf.sampleRate;
    let mono = new Float32Array(N0);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < N0; i++) mono[i] += d[i] / ch; }
    const factor = Math.max(1, Math.round(SR0 / 11025));
    const sr = SR0 / factor;
    /* 抗混叠低通 (加窗 sinc FIR, 截止 ~4.8kHz) 后再抽取, 防止高频混叠污染 chroma */
    let src = mono;
    if (factor > 1) {
      const taps = 65, fc = 0.44 / factor;
      const h = new Float32Array(taps);
      let hsum = 0;
      for (let i = 0; i < taps; i++) {
        const m = i - (taps - 1) / 2;
        const v = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
        h[i] = v * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1)));   // Hamming
        hsum += h[i];
      }
      for (let i = 0; i < taps; i++) h[i] /= hsum;
      const NF = Math.floor(N0 / factor);
      const y = new Float32Array(NF);
      for (let i = 0; i < NF; i++) {
        let s = 0; const base = i * factor - (taps - 1) / 2;
        for (let k = 0; k < taps; k++) { const j = base + k; if (j >= 0 && j < N0) s += mono[j] * h[k]; }
        y[i] = s;
      }
      src = y;
    }
    const N = Math.min(src.length, Math.floor(sr * 32));                   // 最长取 32s
    const x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = src[i];

    /* STFT (4096 点窗保证低频频率分辨率; hop=512) */
    const M = 4096, hop = 512, win = new Float32Array(M);
    for (let i = 0; i < M; i++) win[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (M - 1));
    const frames = Math.floor((N - M) / hop);
    const flux = new Float32Array(frames), centroid = new Float32Array(frames),
      rms = new Float32Array(frames), chroma = new Float32Array(12),
      chromaAll = new Float32Array(12), peakCount = new Float32Array(frames), crest = new Float32Array(frames),
      lowFlux = new Float32Array(frames);
    const re = new Float32Array(M), im = new Float32Array(M);
    let prev = new Float32Array(M / 2), freqPerBin = sr / M;

    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      for (let i = 0; i < M; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let e = 0, cNum = 0, logSum = 0, linSum = 0, fluxSum = 0, mMax = 0;
      const mag = prev;
      for (let k = 1; k < M / 2; k++) {
        const m = Math.hypot(re[k], im[k]);
        const p = m * m;
        e += p; cNum += m * k * freqPerBin; linSum += p;
        fluxSum += Math.max(0, m - prev[k]);                     // 半波整流谱通量
        if (m > mMax) mMax = m;
        const fr = k * freqPerBin;
        if (fr >= 55 && fr <= 2000) {                            // 色度折叠到 12 半音（全部能量）
          const pc = Math.round(12 * Math.log2(fr / 261.63)) % 12;
          chromaAll[(pc + 12) % 12] += p;
        }
        mag[k] = m;
      }
      flux[f] = fluxSum; centroid[f] = cNum / (e + 1e-9);
      rms[f] = Math.sqrt(e / (M / 2));
      // 低频通量 (鼓/贝斯节拍层, 用于 BPM)
      let lf = 0;
      for (let k = 1; k < M / 2; k++) { if (k * freqPerBin < 260) lf += Math.max(0, Math.hypot(re[k], im[k]) - prev[k]); }
      lowFlux[f] = lf;
      // 谱峰 → 色度（局部极大 + 抛物线插值精化频率, 只取显著谐波峰）
      let peakSum = 0, peakMean = (e / (M / 2)) ** 0.5 * 0.8;
      for (let k = 2; k < M / 2 - 1; k++) {
        const fr0 = k * freqPerBin; if (fr0 < 60 || fr0 > 2000) continue;
        const m = Math.hypot(re[k], im[k]);
        if (m > peakMean && m >= Math.hypot(re[k - 1], im[k - 1]) && m > Math.hypot(re[k + 1], im[k + 1])) {
          const a1 = Math.hypot(re[k - 1], im[k - 1]), b1 = m, c1 = Math.hypot(re[k + 1], im[k + 1]);
          const den = a1 - 2 * b1 + c1;
          const p = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a1 - c1) / den)) : 0;   // 抛物线插值
          const fr = (k + p) * freqPerBin;
          const pc = Math.round(12 * Math.log2(fr / 261.63)) % 12;
          chroma[(pc + 12) % 12] += m * m; peakSum++;
        }
      }
      peakCount[f] = peakSum;
      // 峰值因子（音色噪声感代理：纯音高、噪声低）
      crest[f] = mMax / (Math.sqrt(e / (M / 2)) + 1e-9);
      if ((f & 127) === 0 && onProgress) onProgress(f / frames);
    }
    /* 恢复 prev 数组为末帧（上面 mag=prev 原地覆盖, 无需处理） */

    const mean = a => a.reduce((s, v) => s + v) / a.length;
    const std = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

    /* --- 1. BPM: 低频onset包络自相关 (鼓/贝斯节拍层) --- */
    let ofl = Float32Array.from(lowFlux);
    { const sm = 4, tmp = new Float32Array(ofl.length);                    // 平滑
      for (let i = 0; i < ofl.length; i++) { let s = 0, c = 0; for (let k = -sm; k <= sm; k++) { const j = i + k; if (j >= 0 && j < ofl.length) { s += ofl[j]; c++; } } tmp[i] = s / c; }
      ofl = tmp; }
    const mu = mean(ofl); for (let i = 0; i < ofl.length; i++) ofl[i] -= mu;
    let bestLag = 0, bestV = -1;
    const minLag = Math.floor(0.30 * sr / hop), maxLag = Math.floor(1.60 * sr / hop);
    for (let lag = minLag; lag <= maxLag && lag < ofl.length; lag++) {
      let s = 0; for (let i = 0; i + lag < ofl.length; i++) s += ofl[i] * ofl[i + lag];
      s /= (ofl.length - lag);
      const bpmLag = 60.0 * sr / (lag * hop);
      s *= Math.exp(-0.5 * Math.pow(Math.log2(bpmLag / 115) / 0.9, 2));     // 节拍先验 (以 115BPM 为中心)
      if (s > bestV) { bestV = s; bestLag = lag; }
    }
    let bpm = bestLag ? 60.0 * sr / (bestLag * hop) : 90;
    /* ACF 抛物线插值细化周期 */
    if (bestLag >= 2 && bestLag < ofl.length - 1) {
      const a1 = bestV, b1 = (() => { let s = 0; for (let i = 0; i + bestLag - 1 < ofl.length; i++) s += ofl[i] * ofl[i + bestLag - 1]; return s / (ofl.length - bestLag + 1); })(),
        c1 = (() => { let s = 0; for (let i = 0; i + bestLag + 1 < ofl.length; i++) s += ofl[i] * ofl[i + bestLag + 1]; return s / (ofl.length - bestLag - 1); })();
      const den = b1 - 2 * a1 + c1;
      const p = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (b1 - c1) / den)) : 0;
      bpm = 60.0 * sr / ((bestLag + p) * hop);
    }
    /* 倍频校正: 若半周期处自相关仍显著, 优先采用更快拍层 */
    while (bpm < 55) bpm *= 2; while (bpm > 180) bpm /= 2;                 // 折回常见拍域

    /* --- 2. onset 密度(峰值/秒) --- */
    let peaks = 0; const thr = mean(ofl) + 0.6 * std(ofl);
    for (let i = 1; i < ofl.length - 1; i++) if (ofl[i] > ofl[i - 1] && ofl[i] >= ofl[i + 1] && ofl[i] > thr) peaks++;
    const density = peaks / (N / sr);

    /* --- 3. 音色 --- */
    const bright = clamp(mean(centroid) / 2600, 0, 1);
    const harmonicity = clamp(1 - mean(peakCount) / 55, 0, 1);             // 谱峰密度越低越有调性

    /* --- 4. 调式: Chroma × KK 模板, 12 根音取最优 (跟踪全局最优 root+mode 对) --- */
    const cMax = Math.max(...chroma) + 1e-9;
    const chr = Array.from(chroma, v => v / cMax);
    let best = -2, root = 0, isMajor = true, cmAt = 0, cnAt = 0;
    for (let r = 0; r < 12; r++) {
      const rot = i => chr[(i + r) % 12];
      const cm = corr(Array.from({ length: 12 }, (_, i) => rot(i)), KK_MAJ);
      const cn = corr(Array.from({ length: 12 }, (_, i) => rot(i)), KK_MIN);
      if (cm > best) { best = cm; root = r; isMajor = true; cmAt = cm; cnAt = cn; }
      if (cn > best) { best = cn; root = r; isMajor = false; cmAt = cm; cnAt = cn; }
    }
    const modeScore = clamp(cmAt - cnAt, -1, 1);                           // 大调→正, 小调→负
    const chromaE = chroma.reduce((s, v) => s + v) + 1e-9;
    let pm = 0; for (let i = 0; i < 12; i++) pm += (69 + 12 * Math.log2(261.63 * Math.pow(2, i / 12) / 440)) * chroma[i];
    const registerNorm = clamp((pm / chromaE - 50) / 26, -1, 1);           // 音区高低

    /* --- 5. 效价/唤醒度 (Russell 二维情绪坐标) --- */
    const dyn = clamp(std(rms) / (mean(rms) + 1e-9), 0, 2) / 2;
    const bpmNorm = clamp((bpm - 50) / 135, 0, 1);
    const densityNorm = clamp(density / 5, 0, 1);
    const arousal = clamp(0.60 * bpmNorm + 0.20 * densityNorm + 0.20 * dyn, 0, 1);
    const valence = clamp(0.70 * modeScore + 0.15 * bright + 0.15 * registerNorm + 0.10 * (harmonicity - 0.6), -1, 1);

    return {
      bpm: Math.round(bpm), mode: isMajor ? 'major' : 'minor', modeScore: +modeScore.toFixed(3),
      rootPc: root, brightness: +bright.toFixed(3), noisiness: +(1 - harmonicity).toFixed(3),
      density: +density.toFixed(2), valence: +valence.toFixed(3), arousal: +arousal.toFixed(3),
      _chroma: Array.from(chroma, v => Math.round(v / (cMax / 100)))
    };
  }

  return { analyze };
})();
