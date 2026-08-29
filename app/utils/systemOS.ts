export function getOsTypeFromNavigator(): string {
    const userAgent = navigator.userAgent;
    let osType = 'Unknown';
    if (userAgent.indexOf('Win') !== -1) {
        osType = 'Windows_NT';
    } else if (userAgent.indexOf('Mac') !== -1) {
        osType = 'Darwin';
    } else if (userAgent.indexOf('X11') !== -1 || userAgent.indexOf('Linux') !== -1) {
        osType = 'Linux';
    }
    return osType;
}
