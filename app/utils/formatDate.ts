/**
 * 相对时间格式化：把毫秒时间戳格式化为"刚刚 / xx秒前 / xx分钟前 …"或月-日/年-月-日。
 *
 * @param value - 毫秒时间戳（number）或可被 Date 解析的日期字符串；
 *                内部统一归一化，调用方无需再自行 parseInt（此前三处调用点重复强转，
 *                且任何非纯数字串会静默变成"无效日期"）
 * @returns 格式化后的时间字符串；无效输入返回"无效日期"
 */
const formatDate = (value: number | string): string => {
    const now = new Date();

    if (value === undefined || value === null || value === '') {
        return '无效日期';
    }

    const formatTimeDifference = (milliseconds: number): string => {
        const seconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (seconds < 10) {
            return '刚刚';
        } else if (seconds < 60) {
            return `${seconds}秒前`;
        } else if (minutes < 60) {
            return `${minutes}分钟前`;
        } else if (hours < 24) {
            return `${hours}小时前`;
        } else if (days < 7) {
            return `${days}天前`;
        } else {
            const date = new Date(now.getTime() - milliseconds);
            const year = date.getFullYear();
            const month = date.getMonth() + 1;
            const day = date.getDate();
            const currentYear = now.getFullYear();

            if (year === currentYear) {
                return `${month}月${day}日`;
            } else {
                return `${year}年${month}月${day}日`;
            }
        }
    };

    try {
        const ms = typeof value === 'number' ? value : Number(value);
        const currentDate = new Date(Number.isFinite(ms) && ms > 0 ? ms : value);

        if (isNaN(currentDate.getTime())) {
            return '无效日期';
        }

        return formatTimeDifference(now.getTime() - currentDate.getTime());
    } catch (error) {
        console.error('日期格式化错误:', error);
        return '无效日期';
    }
};

export { formatDate };
