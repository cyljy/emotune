/* ============================================================
 * app.js — Vue 3 应用主逻辑
 * ============================================================ */
const { createApp } = Vue;

createApp({
  data() {
    return {
      tab: 'work',
      modelsReady: false, loadStep: '初始化…',
      mode: null, modeName: '', running: false,
      latency: 0,
      faces: [], smProbs: {}, voteAgree: 0, geo: null,
      topEmotion: null, confidence: 0,
      recoTab: 'local',
      tracks: [], reco: [],
      online: { loading: false, term: '', songs: [], error: '' },
      player: { track: null, playing: false, cur: 0, dur: 0 },
      feedback: JSON.parse(localStorage.getItem('emoTune.feedback') || '{}'),
      analyzing: false,
      stream: null,
      /* 情绪联动自动播放 */
      autoPlay: localStorage.getItem('emoTune.autoPlay') !== '0',
      autoUnlocked: false,
      autoStatus: '',
      autoEmo: null,
      demoFaces: [
        { emo: 'happy', name: '开心', color: '#f59e0b' },
        { emo: 'sad', name: '悲伤', color: '#64748b' },
        { emo: 'angry', name: '愤怒', color: '#dc2626' },
        { emo: 'surprised', name: '惊讶', color: '#8b5cf6' },
        { emo: 'fearful', name: '恐惧', color: '#0d9488' },
        { emo: 'disgusted', name: '厌恶', color: '#65a30d' },
        { emo: 'neutral', name: '中性', color: '#2563eb' }
      ],
      emoMeta: {
        happy: { name: '开心', emoji: '😄', color: '#f59e0b' },
        sad: { name: '悲伤', emoji: '😢', color: '#64748b' },
        angry: { name: '愤怒', emoji: '😠', color: '#dc2626' },
        fearful: { name: '恐惧', emoji: '😨', color: '#0d9488' },
        disgusted: { name: '厌恶', emoji: '🤢', color: '#65a30d' },
        surprised: { name: '惊讶', emoji: '😲', color: '#8b5cf6' },
        neutral: { name: '中性', emoji: '😐', color: '#2563eb' }
      },
      expOrder: ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'neutral']
    };
  },

  computed: {
    va() {
      const p = Recommender.PROTO;
      if (this.topEmotion && p[this.topEmotion]) return { v: p[this.topEmotion].v, a: Math.max(0, p[this.topEmotion].a) };
      return { v: 0, a: 0 };
    },
    progress() { return this.player.dur ? (this.player.cur / this.player.dur) * 100 : 0; }
  },

  async mounted() {
    try {
      await EmotionEngine.loadModels(s => this.loadStep = s);
      this.modelsReady = true;
      this.loadStep = '完成';
      this.loadLibrary();
    } catch (e) {
      this.loadStep = '模型加载失败: ' + e.message;
      const viaFile = location.protocol === 'file:';
      alert(viaFile
        ? '当前是直接双击打开(file://)且联网加载也失败。\n推荐方式：在项目文件夹运行本地服务器后访问 http://127.0.0.1:8765/index.html\n(或保持联网后刷新重试，将自动从CDN加载模型)\n' + e.message
        : '模型加载失败，请确认本地服务器已启动(访问 http://127.0.0.1:8765/index.html)，或保持联网后刷新重试。\n' + e.message);
    }
    this._smoother = new EmotionEngine.Smoother();
    this._opt = EmotionEngine.options(320, 0.4);
    /* 浏览器要求音频必须由用户手势解锁 */
    const unlock = () => this.unlockAuto();
    document.addEventListener('pointerdown', unlock, { once: true, passive: true });
    document.addEventListener('keydown', unlock, { once: true });
  },

  methods: {
    /* ---------------- 输入源 ---------------- */
    async pickImage(ev) {
      const f = ev.target.files[0]; if (!f) return;
      await this.setMode('image', '图片识别');
      const url = URL.createObjectURL(f);
      const img = this.$refs.img;
      img.onload = () => this.fitStage();
      img.src = url;
      this.running = true; this.loop();
      ev.target.value = '';
    },
    async pickVideo(ev) {
      const f = ev.target.files[0]; if (!f) return;
      await this.setMode('video', '视频文件');
      const v = this.$refs.video;
      v.src = URL.createObjectURL(f);
      await v.play().catch(() => {});
      this.running = true; this.loop();
      ev.target.value = '';
    },
    async startCamera() {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
        await this.setMode('camera', '实时摄像头');
        this.stream = s;
        const v = this.$refs.video; v.srcObject = s;
        await v.play();
        this.running = true; this.loop();
      } catch (e) { alert('无法打开摄像头：' + e.message + '\n请检查权限或改用图片/视频模式。'); }
    },
    async startScreen() {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        await this.setMode('screen', '屏幕画面');
        this.stream = s;
        s.getVideoTracks()[0].addEventListener('ended', () => this.stopAll());
        const v = this.$refs.video; v.srcObject = s;
        await v.play();
        this.running = true; this.loop();
      } catch (e) { /* 用户取消 */ }
    },
    async useDemoFace(file) {
      await this.setMode('image', '图片识别');
      const img = this.$refs.img;
      img.onload = () => { this.fitStage(); };
      // file:// 打开时本地图片会污染画布导致无法读取像素, 优先用内嵌 data URI
      img.src = (window.DEMO_FACES_DATA && window.DEMO_FACES_DATA[file]) || ('faces/' + file);
      this.running = true; this.loop();
    },
    async setMode(m, name) {
      this.stopAll(true);
      this.mode = m; this.modeName = name;
      await this.$nextTick();
      this.fitStage();
    },
    stopAll(silent) {
      this.running = false;
      if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
      const v = this.$refs.video;
      if (v) { v.srcObject = null; if (this.mode === 'video') v.pause(); }
      this.faces = []; this.topEmotion = null; this.confidence = 0; this.geo = null;
      this._smoother && this._smoother.reset();
      this.clearOverlay();
      if (!silent) { this.mode = null; this.modeName = ''; }
    },
    toggleRun() {
      if (this.running) { this.running = false; return; }
      if (this.mode === 'video') this.$refs.video.play().catch(() => {});
      this.running = true; this.loop();
    },

    /* ---------------- 检测主循环 ---------------- */
    mediaEl() {
      if (this.mode === 'image') return this.$refs.img;
      return this.$refs.video;
    },
    fitStage() { this.$nextTick(() => this.clearOverlay()); },
    async loop() {
      if (!this.running) return;
      const el = this.mediaEl();
      if (!el || (this.mode !== 'image' && !el.videoWidth) || (this.mode === 'image' && !el.naturalWidth)) {
        setTimeout(() => this.loop(), 200); return;
      }
      const t0 = performance.now();
      try {
        const res = await EmotionEngine.detect(el, this._opt);
        this.latency = Math.round(performance.now() - t0);
        this.onDetections(res);
      } catch (e) { /* 忽略偶发推理异常 */ }
      setTimeout(() => this.loop(), this.mode === 'image' ? 400 : 90);
    },
    onDetections(res) {
      this.faces = res;
      if (res.length) {
        const f = res[0];                                    // 主脸 = 面积最大
        let main = res[0];
        for (const r of res) if (r.detection.box.area > main.detection.box.area) main = r;
        const probs = {};
        for (const k of EmotionEngine.EXP_KEYS) probs[k] = main.expressions[k] || 0;
        const sm = this._smoother.push(probs);
        this.smProbs = sm.ema; this.voteAgree = sm.voteAgree;
        this.topEmotion = sm.stable; this.confidence = sm.confidence;
        this.geo = EmotionEngine.geometry(main.landmarks);
        this.drawOverlay(res);
        if (this._lastEmo !== sm.stable || !this.reco.length) {
          this._lastEmo = sm.stable;
          this.refreshReco();
        }
        this.followEmotion(sm.stable, sm.confidence, sm.voteAgree);
      } else {
        this.clearOverlay();
        this._smoother.reset();
        this.topEmotion = null; this.confidence = 0; this.geo = null;
      }
    },

    /* ---------------- 画布叠加层 ---------------- */
    canvasSize() {
      const el = this.mediaEl(), cv = this.$refs.overlay;
      const stage = this.$refs.stage;
      const dw = this.mode === 'image' ? el.clientWidth : el.clientWidth;
      const dh = this.mode === 'image' ? el.clientHeight : el.clientHeight;
      cv.width = stage.clientWidth; cv.height = stage.clientHeight;
      return { sw: el.videoWidth || el.naturalWidth, sh: el.videoHeight || el.naturalHeight, cv };
    },
    drawOverlay(res) {
      const { sw, sh, cv } = this.canvasSize();
      if (!sw || !sh) return;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cv.width, cv.height);
      const sx = cv.width / sw, sy = cv.height / sh;
      for (const f of res) {
        const b = f.detection.box, emo = Object.entries(f.expressions).sort((a, b) => b[1] - a[1])[0];
        const meta = this.emoMeta[emo[0]] || { color: '#2563eb' };
        ctx.strokeStyle = meta.color; ctx.lineWidth = 3;
        ctx.strokeRect(b.x * sx, b.y * sy, b.width * sx, b.height * sy);
        const label = `${this.emoMeta[emo[0]]?.name || emo[0]} ${(emo[1] * 100).toFixed(0)}%`;
        ctx.font = 'bold 16px system-ui';
        const tw = ctx.measureText(label).width + 16;
        ctx.fillStyle = meta.color;
        ctx.fillRect(b.x * sx, Math.max(0, b.y * sy - 26), tw, 26);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, b.x * sx + 8, Math.max(16, b.y * sy - 8));
        // 关键点
        ctx.fillStyle = 'rgba(255,255,255,.75)';
        for (const p of f.landmarks.positions) ctx.fillRect(p.x * sx - 1, p.y * sy - 1, 2, 2);
      }
    },
    clearOverlay() {
      const cv = this.$refs.overlay;
      if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    },

    /* ---------------- 曲库与音频分析 ---------------- */
    async loadLibrary() {
      // 曲库元数据优先用内嵌数据(file:// 下 fetch 不可用), 否则走本地请求
      const lib = window.MUSIC_LIBRARY || await fetch('music/library.json').then(r => r.json());
      const cache = JSON.parse(localStorage.getItem('emoTune.featCache.v2') || '{}');
      this.tracks = lib.map(t => ({ ...t, ...(cache[t.file] || {}) }));
      this.$nextTick(() => this.refreshReco());
      this.analyzeAll();
    },
    async analyzeAll() {
      if (this.analyzing) return;
      this.analyzing = true;
      const cache = JSON.parse(localStorage.getItem('emoTune.featCache.v2') || '{}');
      for (const t of this.tracks) {
        if (cache[t.file]) continue;
        try {
          const f = await AudioFeatures.analyze(t.file);
          Object.assign(t, f);
          // 调式×节奏 规则映射 → 情绪类别（大/小调与快/中/慢速的正交组合）
          t.cls = this.rhythmModeToEmotion(f.bpm, f.mode, f.valence);
          cache[t.file] = f; cache[t.file].cls = t.cls;
          localStorage.setItem('emoTune.featCache.v2', JSON.stringify(cache));
          if (this.reco.some(r => r.id === t.id)) this.refreshReco();
        } catch (e) { console.warn('分析失败', t.id, e); }
      }
      this.analyzing = false;
      this.refreshReco();
    },
    rhythmModeToEmotion(bpm, mode, valence) {
      const fast = bpm >= 118, slow = bpm < 84, mid = !fast && !slow;
      if (fast) return valence > 0.35 ? 'happy' : (valence > 0.10 ? 'surprised' : 'angry');
      if (mid) return mode === 'major' ? 'neutral' : (valence < -0.05 ? 'fearful' : 'disgusted');
      return mode === 'major' ? 'calm' : 'sad';
    },
    nearestEmotion(v, a) {
      const P = Recommender.PROTO;
      let best = 'neutral', bd = 9;
      for (const k in P) {
        const d = Math.hypot(P[k].v - v, P[k].a - a);
        if (d < bd) { bd = d; best = k; }
      }
      return best;
    },
    refreshReco() {
      if (!this.topEmotion) { this.reco = this.tracks.slice(0, 6); return; }
      this.reco = Recommender.recommend(this.tracks, this.topEmotion, this.feedback, 6);
    },
    feedbackOn(t, v) {
      this.feedback[t.id] = (this.feedback[t.id] || 0) + v;
      localStorage.setItem('emoTune.feedback', JSON.stringify(this.feedback));
      this.refreshReco();
    },

    /* ---------------- 在线歌曲 ---------------- */
    async switchOnline() {
      this.recoTab = 'online';
      if (this.online.songs.length) return;
      await this.loadOnline();
    },
    async loadOnline() {
      this.online.loading = true; this.online.error = '';
      try {
        const emo = this.topEmotion || 'neutral';
        const r = await Recommender.searchOnline(emo, 8);
        this.online.term = r.term; this.online.songs = r.songs;
      } catch (e) {
        this.online.error = '在线检索失败（' + e.message + '）。请检查网络；本地曲库不受影响。';
      }
      this.online.loading = false;
    },

    /* ---------------- 播放器 ---------------- */
    /* 取音频元素: 优先模板 ref, 极端情况下兜底创建, 保证自动播放永不因 DOM 缺失而失败 */
    audioEl() {
      let a = this.$refs.audio;
      if (!a) {
        a = new Audio();
        a.addEventListener('timeupdate', () => this.onTime());
        a.addEventListener('ended', () => this.onEnded());
        this._audioFallback = a;
      }
      return a;
    },
    playTrack(t) {
      if (this.player.track && this.player.track.id === t.id) { this.togglePlay(); return; }
      this.loadTrack(t, false);
    },
    /* fade=true 时旧曲淡出、新曲淡入, 实现情绪切换的平滑过渡 */
    loadTrack(t, fade) {
      const audio = this.audioEl();
      const start = () => {
        this.player.track = t;
        audio.src = t.file;
        audio.volume = fade ? 0 : 1;
        audio.play().then(() => {
          this.player.playing = true;
          if (fade) this.fadeTo(1, 550);
        }).catch(e => {
          this.player.playing = false;
          if (fade) this.autoStatus = '浏览器拦截了自动播放，请点击页面任意处启用声音';
          else alert('播放失败：' + e.message);
        });
      };
      if (fade && this.player.playing) this.fadeTo(0, 220, start);
      else start();
    },
    fadeTo(target, ms, done) {
      const audio = this.audioEl(), from = audio.volume, t0 = performance.now();
      const step = now => {
        const k = Math.min(1, (now - t0) / ms);
        audio.volume = Math.max(0, Math.min(1, from + (target - from) * k));
        if (k < 1) requestAnimationFrame(step); else done && done();
      };
      requestAnimationFrame(step);
    },

    /* ---------------- 情绪联动自动切歌 ---------------- */
    unlockAuto() {
      if (this.autoUnlocked) return;
      this.autoUnlocked = true;
      if (this.autoPlay) this.autoStatus = '已解锁音频，识别到稳定情绪后自动开播';
    },
    toggleAuto() {
      this.autoPlay = !this.autoPlay;
      localStorage.setItem('emoTune.autoPlay', this.autoPlay ? '1' : '0');
      this.autoStatus = this.autoPlay ? '自动播放已开启：情绪变化即换歌' : '自动播放已关闭';
      if (this.autoPlay) { this.autoEmo = null; this._autoStreak = 0; }
    },
    followEmotion(emo, conf, agree) {
      if (!this.autoPlay) return;
      /* 三重稳定性门槛: 置信度 + 滑窗一致性 + 连续 2 帧同情绪, 避免抖动频繁切歌 */
      if (!emo || conf < 0.45 || agree < 0.6) { this._autoStreak = 0; return; }
      if (emo === this._autoStreakEmo) this._autoStreak = (this._autoStreak || 0) + 1;
      else { this._autoStreakEmo = emo; this._autoStreak = 1; }
      if (this._autoStreak < 2) return;
      if (emo === this.autoEmo && this.player.playing) return;

      const t = this.reco[0];
      if (!t) return;
      if (this.player.track && this.player.track.id === t.id && this.player.playing) { this.autoEmo = emo; return; }

      this.autoEmo = emo;
      const meta = this.emoMeta[emo];
      this.autoStatus = (this.player.playing ? '情绪变化 → ' : '自动开播 → ')
        + (meta ? meta.name : emo) + '《' + t.title + '》';
      this.loadTrack(t, true);
    },

    togglePlay() {
      const audio = this.audioEl(); if (!this.player.track) return;
      if (this.player.playing) { audio.pause(); this.player.playing = false; }
      else { audio.play().then(() => this.player.playing = true).catch(() => {}); }
    },
    onTime() { const a = this.audioEl(); this.player.cur = a.currentTime || 0; this.player.dur = a.duration || 0; },
    onEnded() { this.player.playing = false; },
    seek(ev) {
      const a = this.audioEl(); if (!a.duration) return;
      const rect = ev.currentTarget.getBoundingClientRect();
      a.currentTime = (ev.clientX - rect.left) / rect.width * a.duration;
    },
    fmt(s) { if (!isFinite(s)) return '0:00'; const m = Math.floor(s / 60), ss = Math.floor(s % 60); return m + ':' + String(ss).padStart(2, '0'); }
  }
}).mount('#app');
