# 🎵 EmoTune — 基于人脸情绪识别的歌曲推荐系统

纯前端实现（HTML5 + CSS3 + JavaScript + Vue 3），无需后端。

## 在线访问

🚀 **https://cyljy.github.io/emotune/**

（GitHub Pages 部署，HTTPS 环境，摄像头/屏幕采集均可正常授权使用）

## 功能

- **四种人脸输入**：图片上传 / 视频文件 / 实时摄像头 / 屏幕画面采集
- **21 张 AI 生成逼真情绪人脸**（7 类情绪 × 3 张），点击即测
- **情绪联动自动播放**：识别到稳定情绪自动开播对应歌曲，情绪变化时淡入淡出实时换歌
- **本地曲库 13 首**（程序合成器乐）+ iTunes 在线试听检索

## 算法

1. **人脸情绪识别**（face-api.js，全部本地推理）
   - TinyFaceDetector（~190KB，单帧 <15ms）+ 68 点关键点 + 8 层 CNN 表情分类
   - EMA 平滑 α=0.55 + 7 帧滑窗投票 + 68 点几何 AU 特征（微笑曲率/眼开度/挑眉等）
2. **旋律情绪识别**（纯前端 DSP）
   - 4096 点 STFT + 抗混叠 FIR 重采样 → onset 自相关求 BPM（节拍先验消除倍频歧义）
   - 谱峰 Chroma × Krumhansl 模板判大小调 → Russell 效价-唤醒坐标 → 调式×节奏规则映射
   - 实测：曲库调式判定 13/13 正确，BPM 误差 <10%
3. **推荐算法**
   - `Score = 0.40·VA高斯核匹配 + 0.35·Plutchik情绪相邻度 + 0.15·律动匹配 + 0.10·Bandit个性化反馈 + ε探索`
   - 👍/👎 反馈持久化生效

## 运行

直接双击 `index.html` 即可使用（模型会自动从 CDN 回退加载）。

完整功能（含音频 DSP 分析）建议本地服务器运行：

```bash
python -m http.server 8765
# 访问 http://127.0.0.1:8765
```

## 隐私

人脸画面全程仅在浏览器本地推理，不上传、不存储。

## 目录结构

```
index.html          主页面(工作台/使用说明/算法说明)
css/style.css       样式
js/app.js           Vue 应用主逻辑(含情绪联动自动切歌)
js/emotion.js       人脸情绪识别引擎
js/audioFeatures.js 音频特征 DSP 算法
js/recommender.js   推荐算法 + iTunes 在线检索
js/demoFacesData.js 演示人脸 base64 内嵌
js/libraryData.js   曲库元数据内嵌
models/             face-api 权重
music/              本地曲库 mp3
faces/              演示人脸图
tools/              曲库/人脸图生成脚本(Python)
vendor/             vue3 / face-api.js
```
