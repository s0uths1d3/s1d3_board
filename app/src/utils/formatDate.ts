/**
 * 将日期字符串格式化为相对时间或具体日期
 * @param {string} dateString - ISO 8601格式的日期字符串
 * @returns {string} 格式化后的时间字符串
 * @description
 * 根据传入的日期字符串与当前时间的差值,返回不同格式的时间描述:
 * - 10秒内显示"刚刚"
 * - 1分钟内显示"xx秒前"
 * - 1小时内显示"xx分钟前"
 * - 24小时内显示"xx小时前"
 * - 7天内显示"xx天前"
 * - 同年显示"月-日"
 * - 不同年显示"年-月-日"
 * - 无效日期返回"无效日期"
 */
const formatDate = (dateString: number): string => {
    const now = new Date();

    if (!dateString) {
        return '无效日期';
    }

    const getTimeDifference = (currentDate: Date): number => {
        return now.getTime() - currentDate.getTime();
    };

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
        const currentDate = new Date(dateString);

        if (isNaN(currentDate.getTime())) {
            return '无效日期';
        }

        const timeDifference = getTimeDifference(currentDate);
        return formatTimeDifference(timeDifference);
    } catch (error) {
        console.error('日期格式化错误:', error);
        return '无效日期';
    }
};

function formatTimestamp(timestamp: number): string {
    // 将毫秒级的时间戳转换为秒级的时间戳
    const seconds = Math.floor(timestamp / 1000);
    const date = new Date(seconds * 1000);

    // 获取年份
    const year = date.getFullYear();

    // 获取月份（要加1，因为月份是从0开始的），并补零
    const month = String(date.getMonth() + 1).padStart(2, '0');

    // 获取日，并补零
    const day = String(date.getDate()).padStart(2, '0');

    // 获取小时，并补零
    const hours = String(date.getHours()).padStart(2, '0');

    // 获取分钟，并补零
    const minutes = String(date.getMinutes()).padStart(2, '0');

    // 获取秒，并补零
    const secs = String(date.getSeconds()).padStart(2, '0');

    // 组合成“年-月-日 时:分:秒”的格式
    return `${year}-${month}-${day} ${hours}:${minutes}:${secs}`;
}

export { formatTimestamp,formatDate };
