/* ============================================================
 * emotion.js — 人脸情绪识别引擎 (face-api.js 本地推理)
 * ----------------------------------------------------------------
 * 网络结构:
 *   TinyFaceDetector  — 9 层全卷积轻量检测器 (~190KB), 输入 320px, 单帧 <15ms
 *   FaceLandmark68Net — 68 点人脸关键点回归 (~350KB)
 *   FaceExpressionNet — 8 层 CNN 表情分类器 (~310KB), 输出 7 类概率
 * 平滑策略: 指数滑动平均 (EMA, α=0.55) + 7 帧滑窗多数投票
 * 几何辅助: 68 点计算 AU 近似特征 (微笑曲率/眼开度/眉距/张嘴度)
 * ============================================================ */
const EmotionEngine = (() => {

  const EXP_KEYS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];

  /* 模型加载: 优先本地权重; 若页面以 file:// 打开或本地服务未启动 (fetch 受限),
     自动回退到 jsDelivr CDN 的同一份官方权重 (CORS 已开放, 无需服务器) */
  const CDN_URI = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';
  const NETS = () => [faceapi.nets.tinyFaceDetector, faceapi.nets.faceLandmark68Net, faceapi.nets.faceExpressionNet];

  async function loadModels(onStep) {
    const names = ['人脸检测器', '关键点网络', '表情网络'];
    for (let i = 0; i < 3; i++) {
      try {
        await NETS()[i].loadFromUri('models');
      } catch (e) {
        console.warn('本地模型加载失败, 回退 CDN:', e.message);
        await NETS()[i].loadFromUri(CDN_URI);
      }
      onStep && onStep(names[i]);
    }
  }

  function options(inputSize = 320, scoreThreshold = 0.4) {
    return new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold });
  }

  async function detect(el, opt) {
    return faceapi.detectAllFaces(el, opt).withFaceLandmarks().withFaceExpressions();
  }

  /* ---------- 时序平滑器 ---------- */
  class Smoother {
    constructor(alpha = 0.55, window = 7) {
      this.alpha = alpha; this.window = window;
      this.ema = null; this.votes = [];
    }
    push(probs) {
      // EMA: S_t = α·x_t + (1-α)·S_{t-1}  —— 抑制单帧抖动
      if (!this.ema) this.ema = { ...probs };
      else for (const k of EXP_KEYS) this.ema[k] = this.alpha * probs[k] + (1 - this.alpha) * this.ema[k];
      const top = EXP_KEYS.reduce((a, b) => probs[a] >= probs[b] ? a : b);
      this.votes.push(top);
      if (this.votes.length > this.window) this.votes.shift();
      const count = {};
      this.votes.forEach(v => count[v] = (count[v] || 0) + 1);
      const stable = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
      const conf = this.ema[stable];
      return { ema: { ...this.ema }, stable, confidence: conf, voteAgree: count[stable] / this.votes.length };
    }
    reset() { this.ema = null; this.votes = []; }
  }

  /* ---------- 68 点几何特征 (FACS AU 近似) ---------- */
  function geometry(lm) {
    const P = lm.positions;
    const d = (a, b) => Math.hypot(P[a].x - P[b].x, P[a].y - P[b].y);
    const iod = d(39, 42) + 1e-6;                       // 瞳距归一化
    const mouthW = d(48, 54);
    const mouthMidY = (P[62].y + P[66].y) / 2;          // 上下唇中点
    const cornerLift = (mouthMidY - (P[48].y + P[54].y) / 2) / mouthW;    // 嘴角高于唇中点 → 微笑为正
    const ear = (a, b) => (d(a + 1, a + 3) + d(a + 2, a + 4)) / (2 * d(a, a + 3) * iod) * iod;
    const eyeOpen = ((ear(36) + ear(42)) / 2);
    const browRaise = ((P[37].y + P[44].y) / 2 - (P[19].y + P[24].y) / 2) / iod;
    const browFurrow = d(21, 22) / iod;
    const mouthOpen = d(62, 66) / iod;
    const noseWrinkle = d(31, 35) / iod;
    return {
      smile: +cornerLift.toFixed(3),          // >0 笑
      eyeOpen: +eyeOpen.toFixed(3),           // 睁眼度
      browRaise: +browRaise.toFixed(3),       // 挑眉
      browFurrow: +browFurrow.toFixed(3),     // 皱眉(眉间距)
      mouthOpen: +mouthOpen.toFixed(3),       // 张嘴
      noseWrinkle: +noseWrinkle.toFixed(3)    // 鼻距(皱鼻时变化)
    };
  }

  return { EXP_KEYS, loadModels, options, detect, Smoother, geometry };
})();
