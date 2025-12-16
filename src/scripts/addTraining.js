const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

// Colores para la consola
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    red: '\x1b[31m'
};

const log = {
    title: (msg) => console.log(`\n${colors.bright}${colors.cyan}${'═'.repeat(50)}${colors.reset}`),
    header: (msg) => console.log(`${colors.bright}${colors.cyan}${msg}${colors.reset}`),
    success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
    info: (msg) => console.log(`${colors.blue}ℹ️  ${msg}${colors.reset}`),
    warn: (msg) => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`),
    error: (msg) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
    option: (num, text) => console.log(`${colors.yellow}  ${num}${colors.reset} → ${text}`)
};

// Configuración de edificios y tropas por raza
const TROOPS_BY_RACE = {
    romanos: {
        barracks: [
            { index: 1, name: 'Legionario', desc: 'Infantería básica' },
            { index: 2, name: 'Pretoriano', desc: 'Defensa infantería' },
            { index: 3, name: 'Imperano', desc: 'Ataque infantería' },
            { index: 4, name: 'Equites Legati', desc: 'Explorador' },
            { index: 5, name: 'Equites Imperatoris', desc: 'Caballería ataque' },
            { index: 6, name: 'Equites Caesaris', desc: 'Caballería élite' }
        ],
        stable: [
            { index: 1, name: 'Equites Legati', desc: 'Explorador' },
            { index: 2, name: 'Equites Imperatoris', desc: 'Caballería ataque' },
            { index: 3, name: 'Equites Caesaris', desc: 'Caballería élite' }
        ],
        workshop: [
            { index: 1, name: 'Ariete', desc: 'Destruye murallas' },
            { index: 2, name: 'Catapulta de Fuego', desc: 'Destruye edificios' }
        ],
        residence: [
            { index: 1, name: 'Senador', desc: 'Conquista aldeas' },
            { index: 2, name: 'Colono', desc: 'Funda aldeas' }
        ]
    },
    germanos: {
        barracks: [
            { index: 1, name: 'Luchador de Porra', desc: 'Infantería básica barata' },
            { index: 2, name: 'Lancero', desc: 'Defensa infantería' },
            { index: 3, name: 'Hacha', desc: 'Ataque infantería' },
            { index: 4, name: 'Explorador', desc: 'Espía' },
            { index: 5, name: 'Paladín', desc: 'Caballería defensa' },
            { index: 6, name: 'Jinete Teutón', desc: 'Caballería ataque' }
        ],
        stable: [
            { index: 1, name: 'Explorador', desc: 'Espía' },
            { index: 2, name: 'Paladín', desc: 'Caballería defensa' },
            { index: 3, name: 'Jinete Teutón', desc: 'Caballería ataque' }
        ],
        workshop: [
            { index: 1, name: 'Ariete', desc: 'Destruye murallas' },
            { index: 2, name: 'Catapulta', desc: 'Destruye edificios' }
        ],
        residence: [
            { index: 1, name: 'Cabecilla', desc: 'Conquista aldeas' },
            { index: 2, name: 'Colono', desc: 'Funda aldeas' }
        ]
    },
    galos: {
        barracks: [
            { index: 1, name: 'Falange', desc: 'Infantería defensa' },
            { index: 2, name: 'Espada', desc: 'Ataque infantería' },
            { index: 3, name: 'Batidor', desc: 'Explorador' },
            { index: 4, name: 'Rayo de Teutates', desc: 'Caballería ataque' },
            { index: 5, name: 'Druida', desc: 'Caballería defensa' },
            { index: 6, name: 'Haeduano', desc: 'Caballería élite' }
        ],
        stable: [
            { index: 1, name: 'Batidor', desc: 'Explorador' },
            { index: 2, name: 'Rayo de Teutates', desc: 'Caballería ataque' },
            { index: 3, name: 'Druida', desc: 'Caballería defensa' },
            { index: 4, name: 'Haeduano', desc: 'Caballería élite' }
        ],
        workshop: [
            { index: 1, name: 'Ariete', desc: 'Destruye murallas' },
            { index: 2, name: 'Catapulta', desc: 'Destruye edificios' }
        ],
        residence: [
            { index: 1, name: 'Jefe', desc: 'Conquista aldeas' },
            { index: 2, name: 'Colono', desc: 'Funda aldeas' }
        ]
    }
};

const BUILDING_NAMES = {
    barracks: '🏛️  Cuartel',
    stable: '🐴 Establo',
    workshop: '⚙️  Taller',
    residence: '🏠 Residencia/Palacio'
};

async function getAccount() {
    const { data: accounts } = await supabase
        .from('accounts')
        .select('id, username, server_url')
        .limit(10);

    if (!accounts || accounts.length === 0) {
        log.error('No hay cuentas registradas en la base de datos.');
        process.exit(1);
    }

    if (accounts.length === 1) {
        log.info(`Cuenta encontrada: ${accounts[0].username}`);
        return accounts[0];
    }

    console.log('\n📋 Selecciona una cuenta:\n');
    accounts.forEach((acc, i) => {
        log.option(i + 1, `${acc.username} (${acc.server_url || 'servidor no definido'})`);
    });

    const selection = await question('\n→ Número de cuenta: ');
    const index = parseInt(selection) - 1;

    if (index < 0 || index >= accounts.length) {
        log.error('Selección inválida');
        process.exit(1);
    }

    return accounts[index];
}

async function selectRace() {
    console.log('\n🏰 Selecciona tu raza:\n');
    log.option(1, 'Romanos');
    log.option(2, 'Germanos');
    log.option(3, 'Galos');

    const selection = await question('\n→ Número: ');
    
    switch(selection.trim()) {
        case '1': return 'romanos';
        case '2': return 'germanos';
        case '3': return 'galos';
        default:
            log.warn('Selección inválida, usando Romanos por defecto');
            return 'romanos';
    }
}

async function selectBuilding() {
    console.log('\n🏗️  Selecciona el edificio:\n');
    log.option(1, BUILDING_NAMES.barracks);
    log.option(2, BUILDING_NAMES.stable);
    log.option(3, BUILDING_NAMES.workshop);
    log.option(4, BUILDING_NAMES.residence);

    const selection = await question('\n→ Número: ');
    
    switch(selection.trim()) {
        case '1': return 'barracks';
        case '2': return 'stable';
        case '3': return 'workshop';
        case '4': return 'residence';
        default:
            log.error('Selección inválida');
            return null;
    }
}

async function selectTroop(race, buildingType) {
    const troops = TROOPS_BY_RACE[race][buildingType];
    
    if (!troops || troops.length === 0) {
        log.error(`No hay tropas disponibles para ${buildingType}`);
        return null;
    }

    console.log(`\n⚔️  Selecciona la tropa:\n`);
    troops.forEach((troop, i) => {
        log.option(i + 1, `${troop.name} - ${troop.desc}`);
    });

    const selection = await question('\n→ Número: ');
    const index = parseInt(selection) - 1;

    if (index < 0 || index >= troops.length) {
        log.error('Selección inválida');
        return null;
    }

    return troops[index];
}

async function getQuantity() {
    console.log('\n📊 Cantidad a entrenar:\n');
    log.option('N', 'Número específico (ej: 10, 50, 100)');
    log.option('M', 'Máximo posible (entrena todos los que puedas)');

    const input = await question('\n→ Cantidad (número o M para máximo): ');
    
    if (input.trim().toUpperCase() === 'M') {
        return -1; // -1 significa máximo
    }

    const qty = parseInt(input);
    if (isNaN(qty) || qty <= 0) {
        log.warn('Cantidad inválida, usando 10 por defecto');
        return 10;
    }

    return qty;
}

async function getRepeatSettings() {
    console.log('\n🔄 ¿Repetir entrenamiento?\n');
    log.option(1, 'No, solo una vez');
    log.option(2, 'Sí, repetir continuamente');

    const selection = await question('\n→ Número: ');

    if (selection.trim() === '2') {
        const interval = await question('→ Intervalo entre entrenamientos (minutos, 0 = inmediato): ');
        return {
            repeat_forever: true,
            repeat_interval: parseInt(interval) || 0
        };
    }

    return {
        repeat_forever: false,
        repeat_interval: 0
    };
}

async function getPriority() {
    console.log('\n⭐ Prioridad de la tarea:\n');
    log.option(1, 'Baja (10) - Se ejecuta al final');
    log.option(2, 'Normal (50) - Prioridad estándar');
    log.option(3, 'Alta (80) - Se ejecuta antes');
    log.option(4, 'Urgente (100) - Máxima prioridad');

    const selection = await question('\n→ Número: ');

    switch(selection.trim()) {
        case '1': return 10;
        case '2': return 50;
        case '3': return 80;
        case '4': return 100;
        default: return 50;
    }
}

async function confirmAndSave(account, taskData) {
    log.title();
    log.header('📋 RESUMEN DE LA TAREA');
    log.title();
    
    console.log(`
   Cuenta:      ${colors.cyan}${account.username}${colors.reset}
   Edificio:    ${colors.yellow}${BUILDING_NAMES[taskData.building_type]}${colors.reset}
   Tropa:       ${colors.green}${taskData.troop_name}${colors.reset}
   Cantidad:    ${colors.magenta}${taskData.quantity === -1 ? 'MÁXIMO' : taskData.quantity}${colors.reset}
   Repetir:     ${taskData.repeat_forever ? `${colors.yellow}Sí (cada ${taskData.repeat_interval} min)${colors.reset}` : 'No'}
   Prioridad:   ${taskData.priority}
`);

    const confirm = await question('→ ¿Confirmar? (s/n): ');

    if (confirm.toLowerCase() !== 's' && confirm.toLowerCase() !== 'si') {
        log.warn('Tarea cancelada');
        return false;
    }

    // Insertar en base de datos
    const { data, error } = await supabase
        .from('training_queue')
        .insert({
            account_id: account.id,
            building_type: taskData.building_type,
            troop_name: taskData.troop_name,
            troop_index: taskData.troop_index,
            quantity: taskData.quantity,
            repeat_forever: taskData.repeat_forever,
            repeat_interval: taskData.repeat_interval,
            priority: taskData.priority,
            status: 'pending'
        })
        .select()
        .single();

    if (error) {
        log.error(`Error al guardar: ${error.message}`);
        return false;
    }

    log.success(`¡Tarea de entrenamiento creada! ID: ${data.id.slice(0, 8)}...`);
    return true;
}

async function showCurrentTasks(accountId) {
    const { data: tasks } = await supabase
        .from('training_queue')
        .select('*')
        .eq('account_id', accountId)
        .in('status', ['pending', 'in_progress'])
        .order('priority', { ascending: false });

    if (!tasks || tasks.length === 0) {
        log.info('No hay tareas de entrenamiento pendientes');
        return;
    }

    console.log(`\n${colors.cyan}📋 Tareas de entrenamiento actuales:${colors.reset}\n`);
    
    tasks.forEach((task, i) => {
        const qty = task.quantity === -1 ? 'MAX' : task.quantity;
        const repeat = task.repeat_forever ? '🔄' : '';
        const status = task.status === 'in_progress' ? '⏳' : '⏸️';
        console.log(`   ${status} ${task.troop_name || `Tropa #${task.troop_index}`} x${qty} ${repeat} (P:${task.priority})`);
    });
    console.log('');
}

async function askAddAnother() {
    const answer = await question('\n→ ¿Añadir otra tarea de entrenamiento? (s/n): ');
    return answer.toLowerCase() === 's' || answer.toLowerCase() === 'si';
}

async function main() {
    console.clear();
    log.title();
    log.header('     ⚔️  AÑADIR TAREA DE ENTRENAMIENTO ⚔️');
    log.title();

    try {
        // Obtener cuenta
        const account = await getAccount();
        
        // Mostrar tareas actuales
        await showCurrentTasks(account.id);

        let addMore = true;

        while (addMore) {
            // Seleccionar raza (solo la primera vez o si quiere cambiar)
            const race = await selectRace();

            // Seleccionar edificio
            const buildingType = await selectBuilding();
            if (!buildingType) {
                addMore = await askAddAnother();
                continue;
            }

            // Seleccionar tropa
            const troop = await selectTroop(race, buildingType);
            if (!troop) {
                addMore = await askAddAnother();
                continue;
            }

            // Cantidad
            const quantity = await getQuantity();

            // Repetición
            const repeatSettings = await getRepeatSettings();

            // Prioridad
            const priority = await getPriority();

            // Confirmar y guardar
            const taskData = {
                building_type: buildingType,
                troop_name: troop.name,
                troop_index: troop.index,
                quantity,
                ...repeatSettings,
                priority
            };

            await confirmAndSave(account, taskData);

            // ¿Añadir otra?
            addMore = await askAddAnother();
        }

        // Mostrar resumen final
        console.log('\n');
        await showCurrentTasks(account.id);

        log.success('¡Listo! El bot procesará las tareas automáticamente.');

    } catch (error) {
        log.error(`Error: ${error.message}`);
    } finally {
        rl.close();
    }
}

main();