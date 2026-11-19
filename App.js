const API_KEY_CARTAS = 'PEGAR_AQUI_LA_KEY_DE_CARTAS';
const API_KEY_ESTRATEGIA = 'PEGAR_AQUI_LA_KEY_DE_ESTRATEGIA';
const URL_CARTAS = 'https://api.oanor.com/cards-api/v1';
const URL_ESTRATEGIA = 'https://api.oanor.com/blackjack-api/v1';

let mazoLocal = [];
let idMazoApi = null;
let cartasRestantes = 0;

// Llamdas a las Apis
const llamarApi = async (base, key, ruta, parametros = {}) => {
    const consulta = new URLSearchParams(parametros).toString();
    const url = `${base}${ruta}${consulta ? '?' + consulta : ''}`;
    console.log('Url de la peticion', url);
    const respuesta = await fetch(url, { headers: { 'x-oanor-key': key } });
    if (!respuesta.ok) {
        throw new Error(`Error ${respuesta.status} en ${ruta}`);
    }
    const datos = await respuesta.json();
    console.log('Respuesta de', ruta, datos);
    return datos;
};

// nombres
const NOMBRES_VALOR = { ACE: 'A', KING: 'K', QUEEN: 'Q', JACK: 'J', '0': '10', '1': 'A' };
const SIMBOLOS_PALO = {
    S: '♠', SPADES: '♠', H: '♥', HEARTS: '♥',
    D: '♦', DIAMONDS: '♦', C: '♣', CLUBS: '♣'
};

//Convierte cartas
const normalizarCarta = (carta) => {
    let valor = String(carta.value ?? carta.rank ?? String(carta.code ?? '?').slice(0, -1)).toUpperCase();
    valor = NOMBRES_VALOR[valor] ?? valor;
    const palo = String(carta.suit ?? String(carta.code ?? '?').slice(-1)).toUpperCase();
    const imagen = carta.image ?? carta.images?.png ?? carta.img ?? '';
    return { valor, palo: SIMBOLOS_PALO[palo] ?? palo, imagen };
};

const extraerCartas = (datos) => {
    if (Array.isArray(datos)) return datos;
    return datos.cards ?? datos.draw ?? datos.data ?? [];
};

const crearMazoLocal = () => {
    const valores = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const palos = ['♠', '♥', '♦', '♣'];
    const mazo = [];
    palos.forEach((palo) => {
        valores.forEach((valor) => mazo.push({ valor, palo, imagen: '' }));
    });
    // Barajar (Fisher-Yates)
    for (let i = mazo.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [mazo[i], mazo[j]] = [mazo[j], mazo[i]];
    }
    return mazo;
};

const prepararMazo = async () => {
    mazoLocal = crearMazoLocal();
    idMazoApi = null;
    cartasRestantes = 52;
    try {
        const datos = await llamarApi(URL_CARTAS, API_KEY_CARTAS, '/deck');
        const info = datos.data ?? datos; // la respuesta viene dentro de "data"
        idMazoApi = info.deck_id ?? info.id ?? null;
        const cartas = extraerCartas(datos);
        if (cartas.length >= 52) {
            mazoLocal = cartas.map(normalizarCarta);
        }
    } catch (error) {
        console.warn('No se pudo usar la API de cartas, se usa mazo local.', error);
    }
};

const sacarCarta = async () => {
    let carta = null;
    if (idMazoApi) {
        try {
            const datos = await llamarApi(URL_CARTAS, API_KEY_CARTAS, '/draw', { deck_id: idMazoApi, count: 1 });
            const cartas = extraerCartas(datos);
            if (cartas.length > 0) carta = normalizarCarta(cartas[0]);
        } catch (error) {
            console.warn('Falló /draw, se usa mazo local.', error);
            idMazoApi = null;
        }
    }
    if (!carta) {
        if (mazoLocal.length === 0) mazoLocal = crearMazoLocal();
        carta = mazoLocal.pop();
    }
    cartasRestantes--;
    return carta;
};

// Asistente(Blackjack Strategy API) 
const textoDeRespuesta = (datos) => {
    if (typeof datos === 'string') return datos;
    const info = datos.data ?? datos; // la respuesta viene dentro de "data"
    const candidato = info.action_label ?? info.recommendation ?? info.action ?? info.move ?? info.advice ?? info.strategy;
    return candidato ? String(candidato) : JSON.stringify(datos);
};

// Recomendación simple por si la API falla
const sugerenciaLocal = () => {
    const { total, blanda } = calcularMano(manoJugador);
    const visible = valorCarta(manoCrupier[0]);
    if (total >= 17) return 'Plantarse';
    if (blanda && total <= 17) return 'Pedir carta';
    if (total >= 13 && visible <= 6) return 'Plantarse';
    if (total === 12 && visible >= 4 && visible <= 6) return 'Plantarse';
    if (total === 11 || (total === 10 && visible < 10)) {
        return manoJugador.length === 2 ? 'Doblar apuesta' : 'Pedir carta';
    }
    return 'Pedir carta';
};

const consultarSugerencia = async () => {
    ocultarError();
    sugerenciaP.textContent = 'Consultando...';
    const cartasJugador = manoJugador.map((c) => c.valor).join(',');
    const cartaCrupier = manoCrupier[0].valor;
    try {
        // La API espera "cards" y "dealer", con las cartas en minúscula (a, k, q, j)
        const datos = await llamarApi(URL_ESTRATEGIA, API_KEY_ESTRATEGIA, '/strategy', {
            cards: cartasJugador.toLowerCase(),
            dealer: cartaCrupier.toLowerCase()
        });
        sugerenciaP.textContent = `Jugada recomendada: ${textoDeRespuesta(datos)}`;
    } catch (error) {
        console.warn('Falló /strategy, se usa cálculo local.', error);
        sugerenciaP.textContent = `Jugada recomendada (cálculo local): ${sugerenciaLocal()}`;
    }
};

// Probabilidad aproximada de que el crupier se pase, según su carta visible
const PROBABILIDAD_LOCAL = { '2': 35, '3': 37, '4': 40, '5': 42, '6': 42, '7': 26, '8': 24, '9': 23, '10': 23, 'A': 11 };

const consultarProbabilidad = async () => {
    ocultarError();
    probabilidadOut.textContent = 'Consultando...';
    const cartaCrupier = manoCrupier[0].valor;
    try {
        // La API espera "dealer", con la carta en minúscula
        const datos = await llamarApi(URL_ESTRATEGIA, API_KEY_ESTRATEGIA, '/dealer-odds', {
            dealer: cartaCrupier.toLowerCase()
        });
        const info = datos.data ?? datos; // la respuesta viene dentro de "data"
        const bust = info.bust_probability_pct ?? info.bust ?? info.bust_probability ?? info.probability ?? info.bust_chance;
        probabilidadOut.textContent = bust !== undefined ? String(bust) : textoDeRespuesta(datos);
    } catch (error) {
        console.warn('Falló /dealer-odds, se usa tabla local.', error);
        const valor = ['J', 'Q', 'K'].includes(cartaCrupier) ? '10' : cartaCrupier;
        probabilidadOut.textContent = `${PROBABILIDAD_LOCAL[valor]}% (aprox. local)`;
    }
};