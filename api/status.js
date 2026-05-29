export default async function handler(req, res) {
    const { task_id } = req.query;
    const ALIYUN_EMO_KEY = process.env.ALIYUN_EMO_KEY;

    try {
        const dashscopeRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${task_id}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${ALIYUN_EMO_KEY}` }
        });

        const data = await dashscopeRes.json();
        console.log("阿里云详细拒收理由：", JSON.stringify(data));
        res.status(200).json({
            status: data.output.task_status, // 状态: SUCCEEDED, FAILED, PENDING...
            video_url: data.output.video_url || null 
        });

    } catch (error) {
        res.status(500).json({ error: '状态查询失败' });
        
    }
}