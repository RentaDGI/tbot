const { createClient } = require('@supabase/supabase-js');
const GameClient = require('./GameClient');
const { sleep, isNightMode } = require('../utils/time');
const logger = require('../utils/logger');

class TaskRunner {
    constructor() {
        this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        this.client = new GameClient();
        this.isRunning = false;
        this.account = null;
    }

    async start() {
        try {
            await this.client.init();
            
            // Obtener cuenta
            const { data: account } = await this.supabase
                .from('accounts')
                .select('*')
                .eq('username', process.env.GAME_USERNAME)
                .single();
                
            if (!account) throw new Error('Cuenta no encontrada en DB');
            this.account = account;
            logger.init(this.supabase, account.id);

            await this.client.login();
            this.isRunning = true;
            logger.success('=== BOT INICIADO ===');
            
            await this.loop();

        } catch (error) {
            if (!this.isClosedError(error)) {
                logger.error('Error al iniciar', { error: error.message });
            }
        } finally {
            await this.shutdown();
        }
    }

    async loop() {
        while (this.isRunning) {
            try {
                if (isNightMode()) {
                    logger.info('🌙 Modo noche. Durmiendo...');
                    await sleep(30 * 60 * 1000);
                    continue;
                }

                // 1. Revisar Aventuras (Probabilidad 30% por ciclo)
                if (Math.random() > 0.7) { 
                   await this.client.checkAndStartAdventure();
                }

                // 2. Obtener TODAS las tareas pendientes (lote de 10)
                const tasks = await this.getPendingTasks();

                if (tasks.length === 0) {
                    logger.info('💤 Sin tareas pendientes. Esperando...');
                    await sleep(60000); // 1 minuto
                    continue;
                }

                let builtSomething = false;
                let queueIsFull = false;

                // 3. Iterar sobre las tareas (Lógica de Salto Inteligente)
                logger.info(`📋 Revisando ${tasks.length} tareas pendientes...`);

                for (const task of tasks) {
                    // Intentar construir
                    const result = await this.handleBuild(task);

                    if (result.success) {
                        builtSomething = true;
                        break; // Construcción exitosa, salimos a descansar
                    }

                    // ANÁLISIS DEL RESULTADO
                    if (result.reason === 'completed_already') {
                        // La tarea se completó sola (todos los edificios están al nivel)
                        // Pasamos a la siguiente tarea sin esperar
                        continue;
                    }

                    if (result.reason === 'queue_full') {
                        logger.warn('⏳ Cola de construcción llena. Deteniendo revisión.');
                        queueIsFull = true;
                        break; // No tiene sentido seguir
                    } 
                    
                    if (result.reason === 'not_enough_resources') {
                        logger.warn(`💰 Faltan recursos para ${task.building_name}. Saltando a siguiente tarea...`);
                        continue; // Probamos la siguiente tarea
                    }

                    if (result.reason === 'browser_closed') {
                        this.isRunning = false;
                        break;
                    }

                    // Pausa pequeña entre intentos fallidos para no saturar
                    await sleep(2000);
                }

                // 4. Decidir cuánto dormir
                if (builtSomething) {
                    // Descanso aleatorio tras construir (10-15 seg)
                    await sleep(10000 + Math.random() * 5000);
                } else if (queueIsFull) {
                    // Si cola llena, esperar 2 minutos
                    logger.info('⏳ Esperando 2 minutos por cola llena...');
                    await sleep(120000);
                } else {
                    // Si recorrimos todas y ninguna se pudo hacer (falta de recursos global)
                    logger.info('💤 Ninguna tarea posible (Falta de recursos global). Esperando 5 min...');
                    await sleep(300000);
                }

            } catch (error) {
                if (this.isClosedError(error)) {
                    this.isRunning = false;
                    break;
                }
                logger.error('Error en loop', { error: error.message });
                await sleep(10000);
            }
        }
    }

    async getPendingTasks() {
        const { data } = await this.supabase
            .from('build_queue')
            .select('*')
            .eq('account_id', this.account.id)
            .eq('status', 'pending')
            .order('priority', { ascending: false }) 
            .order('created_at', { ascending: true }) 
            .limit(10); 
        return data || [];
    }

    async handleBuild(task) {
        try {
            let slot = task.building_slot;
            
            // Selección inteligente de slot (recursos)
            if (task.building_type) {
                // Esto busca en la memoria caché (rápido)
                const field = await this.client.findLowestLevelField(task.building_type, task.target_level);
                
                if (!field) {
                    // Si devuelve null, es que ya todos cumplen el nivel
                    logger.success(`✅ Todos los '${task.building_type}' están al nivel ${task.target_level}. Tarea completada.`);
                    await this.completeTask(task.id);
                    return { success: false, reason: 'completed_already' }; 
                }
                
                slot = field.slot;
                logger.info(`🎯 Intentando: ${task.building_name} (Slot ${slot} - Nivel ${field.level})`);
            } else {
                logger.info(`🎯 Intentando: ${task.building_name} (Slot ${slot})`);
            }

            // Navegar
            await this.client.clickBuildingSlot(slot);

            // ACTUALIZACIÓN DE MEMORIA "JUST IN TIME"
            // Visitamos el slot, miramos la realidad y actualizamos la memoria del bot
            if (task.building_type) {
                await this.client.updateCacheForSlot(slot);
            }

            // Intentar construir
            const result = await this.client.upgradeBuild();

            if (result.success) {
                logger.success(`🏗️ Construcción iniciada: ${task.building_name}`);
                
                // Si hubo éxito, actualizamos la memoria de nuevo para marcarlo como "En construcción" (+1 nivel)
                if (task.building_type) {
                    await this.client.updateCacheForSlot(slot);
                }

                // Si es un edificio único (no recurso), marcamos tarea como completada
                if (!task.building_type) {
                    await this.completeTask(task.id);
                }
                return { success: true };
            } else {
                return { success: false, reason: result.reason };
            }

        } catch (error) {
            if (this.isClosedError(error)) return { success: false, reason: 'browser_closed' };
            
            // Si el error es de escáner
            if (error.message.includes('SCAN')) {
                return { success: false, reason: 'scan_error' };
            }

            logger.error('Error en handleBuild', { error: error.message });
            return { success: false, reason: 'error' };
        }
    }

    async completeTask(taskId) {
        await this.supabase.from('build_queue')
            .update({ status: 'completed', completed_at: new Date() })
            .eq('id', taskId);
    }

    isClosedError(error) {
        return error.message && (
            error.message.includes('Target page, context or browser has been closed') ||
            error.message.includes('Session closed') ||
            error.message.includes('browser has been closed')
        );
    }

    async shutdown() {
        logger.info('Cerrando sesión...');
        await this.client.close();
    }
}

module.exports = TaskRunner;