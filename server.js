const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Servir arxius estàtics
app.use(express.static('.'));

// Lògica del joc al servidor
class GameServer {
    constructor() {
        this.players = {};
        this.bullets = [];
        this.gameState = {
            players: {},
            bullets: [],
            timestamp: Date.now()
        };
        
        console.log('🎮 Servidor de joc inicialitzat');
    }

    addPlayer(socketId) {
        this.players[socketId] = {
            id: socketId,
            x: Math.random() * 700 + 50, // Posició aleatòria
            y: Math.random() * 500 + 50,
            velocityX: 0,
            velocityY: 0,
            lastUpdate: Date.now(),
            health: 100,
            score: 0,
            lastShot: 0
        };
        
        console.log(`➕ Jugador ${socketId} afegit al joc (${Object.keys(this.players).length} jugadors totals)`);
    }

    removePlayer(socketId) {
        if (this.players[socketId]) {
            delete this.players[socketId];
            console.log(`➖ Jugador ${socketId} eliminat del joc (${Object.keys(this.players).length} jugadors restants)`);
        }
    }

    updatePlayerPosition(socketId, input) {
        if (!this.players[socketId]) return;

        const player = this.players[socketId];
        const speed = 5;
        
        // Reset velocity
        player.velocityX = 0;
        player.velocityY = 0;

        // Aplicar moviment segons la direcció
        switch (input.direction) {
            case 'left':
                player.velocityX = -speed;
                player.facing = 'left';
                break;
            case 'right':
                player.velocityX = speed;
                player.facing = 'right';
                break;
            case 'up':
                player.velocityY = -speed;
                break;
            case 'down':
                player.velocityY = speed;
                break;
            case 'reset':
                // Reiniciar posició
                player.x = Math.random() * 700 + 50;
                player.y = Math.random() * 500 + 50;
                console.log(`🔄 Jugador ${socketId} reiniciat a nova posició`);
                break;
        }

        // Actualitzar posició si no és reset
        if (input.direction !== 'reset') {
            player.x += player.velocityX;
            player.y += player.velocityY;

            // Mantenir dins dels límits del joc (800x600)
            player.x = Math.max(20, Math.min(780, player.x));
            player.y = Math.max(20, Math.min(580, player.y));
        }

        player.lastUpdate = Date.now();
    }

    createBullet(socketId, data) {
        if (!this.players[socketId]) return;

        const player = this.players[socketId];
        const now = Date.now();
        
        // Control de ratelimit (màxim 5 dispars per segon)
        if (now - player.lastShot < 200) {
            return; // Massa ràpid
        }
        
        player.lastShot = now;

        // Determinar direcció de la bala
        let velocityX = 8; // Per defecte: dreta
        let startX = player.x + 20; // Posició inicial: dreta del jugador
        let direction = data.direction || player.facing || 'right';
        console.log(direction);
        
        if (direction === 'left') {
            velocityX = -8; // Esquerra
            startX = player.x - 20; // Posició inicial: esquerra del jugador
        }

        const bullet = {
            id: `${socketId}-${now}-${Math.random().toString(36).substr(2, 5)}`,
            playerId: socketId,
            x: startX, // Disparar des de la dreta del jugador
            y: player.y,
            velocityX: velocityX,
            velocityY: 0,
            timestamp: now,
            lifespan: 3000, // 3 segons de vida màxima
            direction: data.direction || 'right' // Guardar direcció per al client
        };

        this.bullets.push(bullet);
        console.log(`💥 Bala creada pel jugador ${socketId} (${this.bullets.length} bales actives)`);
    }

    updateBullets() {
        const now = Date.now();
        
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const bullet = this.bullets[i];
            
            // Moure la bala
            bullet.x += bullet.velocityX;
            bullet.y += bullet.velocityY;

            // Eliminar bales que surtin de la pantalla o hagin expirat
            if (bullet.x < -50 || bullet.x > 850 || bullet.y < -50 || bullet.y > 650 || 
                now - bullet.timestamp > bullet.lifespan) {
                this.bullets.splice(i, 1);
                continue;
            }

            // Verificar col·lisions amb jugadors
            this.checkBulletCollisions(bullet, i);
        }
    }

    checkBulletCollisions(bullet, bulletIndex) {
        const bulletRect = {
            x: bullet.x - 5,
            y: bullet.y - 5,
            width: 10,
            height: 10
        };

        Object.keys(this.players).forEach(playerId => {
            const player = this.players[playerId];
            
            // No col·lisionar amb el propi jugador
            if (playerId === bullet.playerId) return;

            // Detecció simple de col·lisió rectangle-rectangle
            const playerRect = {
                x: player.x - 20,
                y: player.y - 20,
                width: 40,
                height: 40
            };

            if (this.checkRectCollision(bulletRect, playerRect)) {
                // Jugador tocat!
                player.health -= 10;
                
                // Actualitzar puntuacions
                if (player.health > 0) {
                    player.score = Math.max(0, player.score - 5);
                }
                
                // El que dispara guanya punts
                if (this.players[bullet.playerId]) {
                    this.players[bullet.playerId].score += 10;
                }

                console.log(`🎯 Jugador ${playerId} tocat per ${bullet.playerId}! Salut: ${player.health}%`);

                // Eliminar la bala
                this.bullets.splice(bulletIndex, 1);

                // Notificar als clients
                io.emit('playerHit', {
                    playerHit: playerId,
                    shooter: bullet.playerId,
                    health: player.health,
                    damage: 10
                });

                // Si la salut arriba a 0, reiniciar jugador
                if (player.health <= 0) {
                    this.respawnPlayer(playerId);
                }

                return; // Sortir del bucle ja que la bala ha col·lisionat
            }
        });
    }

    checkRectCollision(rect1, rect2) {
        return rect1.x < rect2.x + rect2.width &&
               rect1.x + rect1.width > rect2.x &&
               rect1.y < rect2.y + rect2.height &&
               rect1.y + rect1.height > rect2.y;
    }

    respawnPlayer(playerId) {
        const player = this.players[playerId];
        player.x = Math.random() * 700 + 50;
        player.y = Math.random() * 500 + 50;
        player.health = 100;
        player.velocityX = 0;
        player.velocityY = 0;
        console.log(`🔄 Jugador ${playerId} ha reaparegut`);
        
        // Notificar el respawn
        io.emit('playerRespawn', {
            playerId: playerId,
            x: player.x,
            y: player.y
        });
    }

    updateGameState() {
        this.gameState.players = this.players;
        this.gameState.bullets = this.bullets;
        this.gameState.timestamp = Date.now();
        this.gameState.playerCount = Object.keys(this.players).length;
    }

    broadcastGameState() {
        this.updateGameState();
        io.emit('gameState', this.gameState);
    }

    // Neteja de bales antigues (maintenance)
    cleanup() {
        const now = Date.now();
        const initialBulletCount = this.bullets.length;
        
        this.bullets = this.bullets.filter(bullet => 
            now - bullet.timestamp < bullet.lifespan
        );
        
        if (this.bullets.length !== initialBulletCount) {
            console.log(`🧹 Neteja: eliminades ${initialBulletCount - this.bullets.length} bales antigues`);
        }
    }
}

// Inicialitzar el servidor del joc
const gameServer = new GameServer();

// Bucle del joc (60 FPS)
const GAME_LOOP_INTERVAL = 1000 / 60;
setInterval(() => {
    gameServer.updateBullets();
    gameServer.broadcastGameState();
}, GAME_LOOP_INTERVAL);

// Neteja periòdica cada 10 segons
setInterval(() => {
    gameServer.cleanup();
}, 10000);

// Configuració de Socket.IO
io.on('connection', (socket) => {
    console.log('🎮 Nou jugador connectat:', socket.id);
    console.log('📊 Jugadors totals:', Object.keys(gameServer.players).length);

    // Afegir jugador al joc
    gameServer.addPlayer(socket.id);

    // Enviar estat inicial al nou jugador
    socket.emit('gameState', gameServer.gameState);
    
    // Notificar a tots els jugadors el nou compte
    io.emit('playersCount', Object.keys(gameServer.players).length);

    // Notificar entrada al xat
    io.emit('chatMessage', {
        playerId: 'system',
        message: `Jugador ${socket.id.substring(0, 8)} s'ha unit al joc!`,
        timestamp: Date.now(),
        type: 'system'
    });

    // ESDEVENIMENTS QUE REBEM DELS CLIENTS

    // Moviment del jugador
    socket.on('playerInput', (data) => {
        if (data && data.direction) {
            gameServer.updatePlayerPosition(socket.id, data);
        }
    });

    // Disparar
    socket.on('playerShoot', (data) => {
        gameServer.createBullet(socket.id, data);
    });

    // Sol·licitud d'estat del joc
    socket.on('requestGameState', () => {
        socket.emit('gameState', gameServer.gameState);
    });

    // Missatges de xat
    socket.on('chatMessage', (data) => {
        if (data && data.message && data.message.trim().length > 0) {
            const message = data.message.trim().substring(0, 100); // Limit de 100 caràcters
            
            io.emit('chatMessage', {
                playerId: socket.id,
                message: message,
                timestamp: Date.now(),
                type: 'player'
            });
            
            console.log(`💬 Xat [${socket.id.substring(0, 8)}]: ${message}`);
        }
    });

    // Ping/pong per mantenir connexió
    socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
    });

    // Desconnexió
    socket.on('disconnect', (reason) => {
        console.log('👋 Jugador desconnectat:', socket.id, 'Raó:', reason);
        
        // Eliminar jugador del joc
        gameServer.removePlayer(socket.id);
        
        // Notificar a tots els jugadors el nou compte
        io.emit('playersCount', Object.keys(gameServer.players).length);
        
        // Notificar sortida al xat
        io.emit('chatMessage', {
            playerId: 'system',
            message: `Jugador ${socket.id.substring(0, 8)} ha sortit del joc`,
            timestamp: Date.now(),
            type: 'system'
        });
    });

    // Gestió d'errors
    socket.on('error', (error) => {
        console.error('❌ Error de socket:', socket.id, error);
    });
});

// Middleware per a les rutes
app.use(express.json());

// Rutes API
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        players: Object.keys(gameServer.players).length,
        bullets: gameServer.bullets.length,
        uptime: process.uptime(),
        timestamp: Date.now()
    });
});

app.get('/api/players', (req, res) => {
    const playersInfo = Object.keys(gameServer.players).map(playerId => {
        const player = gameServer.players[playerId];
        return {
            id: playerId.substring(0, 8),
            x: Math.round(player.x),
            y: Math.round(player.y),
            health: player.health,
            score: player.score
        };
    });
    
    res.json({
        totalPlayers: playersInfo.length,
        players: playersInfo
    });
});

// Ruta principal - servir el joc
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Middleware per a pàgines no trobades
app.use((req, res) => {
    res.status(404).json({ error: 'Ruta no trobada' });
});

// Gestió d'errors globals
process.on('uncaughtException', (error) => {
    console.error('💥 Error no capturat:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Promise rebutjada:', reason);
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 =================================');
    console.log('🎯 Servidor de joc INICIALITZAT');
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log('🕹️  Joc multijugador amb Phaser + Socket.IO');
    console.log('🚀 =================================');
    
    // Informació inicial
    console.log('📋 Endpoints disponibles:');
    console.log(`   http://localhost:${PORT} - Joc principal`);
    console.log(`   http://localhost:${PORT}/api/status - Estat del servidor`);
    console.log(`   http://localhost:${PORT}/api/players - Llista de jugadors`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Rebut SIGTERM, aturant servidor...');
    server.close(() => {
        console.log('✅ Servidor aturat correctament');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 Rebut SIGINT, aturant servidor...');
    server.close(() => {
        console.log('✅ Servidor aturat correctament');
        process.exit(0);
    });
});