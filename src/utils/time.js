/**
 * Genera número aleatorio con distribución gaussiana
 */
/**
 * Genera número aleatorio con distribución gaussiana
 */
function gaussianRandom(min, max) {
    const u = 1 - Math.random();
    const v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    
    const mean = (min + max) / 2;
    const stdDev = (max - min) / 6;
    
    return Math.max(min, Math.min(max, z * stdDev + mean));
}

/**
 * Espera humanizada con distribución normal
 */
async function humanDelay(page, min = 1000, max = 3000) {
    const delay = Math.round(gaussianRandom(min, max));
    await page.waitForTimeout(delay);
    return delay;
}

/**
 * Espera simple sin página
 */
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Genera un número aleatorio dentro de un rango
 */
function randomInterval(min, max) {
    return Math.round(Math.random() * (max - min) + min);
}

/**
 * Verifica si es hora de dormir (modo noche)
 */
function isNightMode() {
    // CAMBIO: Devolver false para que el bot trabaje 24/7
    return false; 
    
    /* Configuración anterior (guardada por si la quieres luego):
    const hour = new Date().getHours();
    return hour >= 1 && hour < 7;
    */
}

module.exports = {
    gaussianRandom,
    humanDelay,
    sleep,
    randomInterval,
    isNightMode
};
