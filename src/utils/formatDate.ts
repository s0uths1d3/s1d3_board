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
const formatDate = (dateString: string): string => {
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

export { formatDate };

