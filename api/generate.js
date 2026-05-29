import crypto from 'crypto';
import WebSocket from 'ws';
import OSS from 'ali-oss';

// --- 模块 1：科大讯飞 TTS ---
function generateXunfeiTTS(text) {
    return new Promise((resolve, reject) => {
        const APPID = process.env.XUNFEI_APPID;
        const API_KEY = process.env.XUNFEI_API_KEY;
        const API_SECRET = process.env.XUNFEI_API_SECRET;

        const host = "tts-api.xfyun.cn";
        const path = "/v2/tts";
        const date = new Date().toUTCString();
        const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
        const signatureSha = crypto.createHmac('sha256', API_SECRET).update(signatureOrigin).digest('base64');
        const authorizationOrigin = `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signatureSha}"`;
        const authorization = Buffer.from(authorizationOrigin).toString('base64');
        const wsUrl = `wss://${host}${path}?authorization=${authorization}&date=${encodeURI(date)}&host=${host}`;

        const ws = new WebSocket(wsUrl);
        let audioChunks = [];

        ws.on('open', () => {
            ws.send(JSON.stringify({
                common: { app_id: APPID },
                business: { aue: "lame", sfl: 1, vcn: "xiaoyan", speed: 50, volume: 50, pitch: 50, tte: "UTF8" },                data: { status: 2, text: Buffer.from(text).toString('base64') }
            }));
        });

        ws.on('message', (data) => {
            const res = JSON.parse(data);
            if (res.code !== 0) return reject(new Error(`讯飞出错: ${res.message}`));
            if (res.data.audio) audioChunks.push(Buffer.from(res.data.audio, 'base64'));
            if (res.data.status === 2) {
                ws.close();
                resolve(Buffer.concat(audioChunks));
            }
        });
        ws.on('error', reject);
    });
}

// --- 模块 2：阿里云 OSS 上传 ---
async function uploadToOSS(buffer, filename) {
    const client = new OSS({
        region: process.env.OSS_REGION,             // 例: oss-cn-hangzhou
        accessKeyId: process.env.OSS_ACCESS_KEY,
        accessKeySecret: process.env.OSS_SECRET_KEY,
        bucket: process.env.OSS_BUCKET_NAME
    });
    
    // 上传文件并设置公共读权限，EMO 模型才能访问到 URL
    const result = await client.put(filename, buffer, { headers: { 'x-oss-object-acl': 'public-read' } });
    return result.url;
}

// --- 模块 3：主控流程 ---
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { text, imageBase64 } = req.body;
    const ALIYUN_EMO_KEY = process.env.ALIYUN_EMO_KEY; // 阿里云 DashScope Key

    try {
        // 1. 拿讯飞 MP3 音频 Buffer
        const cleanText = text.replace(/[*#_`~]/g, ''); // 这一步会删掉所有奇怪的标点符号
        const audioBuffer = await generateXunfeiTTS(cleanText);

        // 2. 将前端的 Base64 格式图片转为纯 Buffer
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const imageBuffer = Buffer.from(base64Data, 'base64');

       // 3. 上传到 OSS 拿公网 URL (加时间戳防止文件覆盖)
        const timestamp = Date.now();
        const audioUrl = await uploadToOSS(audioBuffer, `audio_${timestamp}.mp3`); 
        const imageUrl = await uploadToOSS(imageBuffer, `avatar_${timestamp}.jpg`); 
        
        // --- 新增：3.5 步，先调用检测接口获取人脸坐标 ---
        const detectRes = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/face-detect', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ALIYUN_EMO_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'emo-detect-v1',
                input: { image_url: imageUrl },
                parameters: { ratio: "1:1" } // 1:1 代表生成头像视频
            })
        });

        const detectData = await detectRes.json();
        
        // 如果图片没过审（比如没找到人脸），直接抛出报错
        if (!detectData.output || !detectData.output.check_pass) {
            throw new Error('阿里云未检测到合格人脸，请更换图片: ' + JSON.stringify(detectData));
        }

        const faceBbox = detectData.output.face_bbox;
        const extBbox = detectData.output.ext_bbox;

        // --- 第 4 步：带着坐标，正式提交给阿里云 EMO 模型 ---
        const dashscopeRes = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis/', {
            method: 'POST',
            headers: {
                'X-DashScope-Async': 'enable',
                'Authorization': `Bearer ${ALIYUN_EMO_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'emo-v1',
                input: { 
                    image_url: imageUrl, 
                    audio_url: audioUrl,
                    face_bbox: faceBbox,   // <--- 核心修复：带上人脸核心坐标
                    ext_bbox: extBbox      // <--- 核心修复：带上人脸扩展坐标
                }
            })
        });

        const data = await dashscopeRes.json();
        if(!data.output || !data.output.task_id) throw new Error(JSON.stringify(data));
        
        res.status(200).json({ task_id: data.output.task_id });

    } catch (error) {
        console.error("详细报错：", error);
        res.status(500).json({ error: '生成失败', details: error.message });
    }
}