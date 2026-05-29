export default async function handler(req, res) {
    // 1. 从前端的请求中获取任务 ID
    const { task_id } = req.query;
    const ALIYUN_EMO_KEY = process.env.ALIYUN_EMO_KEY;

    try {
        // 2. 去阿里云查询该任务的真实进度
        const dashscopeRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${task_id}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${ALIYUN_EMO_KEY}`
            }
        });

        const data = await dashscopeRes.json();
        
        // 这里的日志会完整打印在 Vercel 监控里
        console.log("阿里云详细返回数据：", JSON.stringify(data));

        // 核心：直接把阿里云最完整的原始数据返回给前端！
        res.status(200).json(data);

    } catch (error) {
        console.error("查询状态出错：", error);
        res.status(500).json({ error: '查询失败', details: error.message });
    }
}