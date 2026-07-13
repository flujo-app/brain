/**
 * Tiny dependency-free i18n for the lobby.
 *
 * - `t(key, vars)` looks the key up in the active language, falling back to
 *   English, then to the key itself.
 * - Static markup opts in via `data-i18n="key"` (textContent) and
 *   `data-i18n-ph="key"` (placeholder); `applyI18n()` fills both.
 * - The choice persists in localStorage and `onLangChange` lets dynamic
 *   renderers (orbit card, wizard) repaint themselves.
 */

export type Lang = 'en' | 'de' | 'es' | 'fr';

export const LANGS: Array<{ id: Lang; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
];

const en: Record<string, string> = {
  'app.subtitle': 'every brain lives its own life, chasing a goal you give it',
  'lobby.offline': '⚠ the brain keeper is not running — start it with',
  'lobby.adoptMode': '🐳 Docker is not available here — new brains move into your existing FLUJO at {url}. Make sure it is running.',

  'orbit.new': 'new brain',
  'orbit.hint': 'click a brain to visit it — click + to grow a new one',
  'orbit.empty': 'no brains yet — press + to grow your first one',
  'orbit.taken': 'this FLUJO already hosts a brain',
  'orbit.connect': 'connect to a FLUJO in your network',

  'connect.title': 'Connect to a FLUJO in your network',
  'connect.desc':
    'Enter the address of a running FLUJO instance — a brain grown elsewhere joins the lobby as it is; an empty instance can grow one.',
  'connect.go': 'connect',
  'connect.noStem': 'connected — no brain-stem there yet. Open it and grow one.',

  'status.ready': 'awake',
  'status.idle': 'idle',
  'status.provisioning': 'being born…',
  'status.error': 'needs help',

  'card.open': 'open this brain →',
  'card.editor': 'FLUJO editor ↗',
  'card.forget': 'forget',
  'card.forgetConfirm': 'Forget "{name}"? Its home is removed, but its memories are kept.',
  'card.rebuild': 'rebuild',
  'card.rebuildConfirm': 'Rebuild "{name}"’s home from the current image? Its memories are kept — it is briefly offline.',
  'card.born': 'born {date}',
  'card.noModel': 'no mind yet',
  'card.kind.managed': 'its own home',
  'card.kind.external': 'shared home',

  'wiz.title': 'grow a new brain',
  'wiz.back': 'back',
  'wiz.next': 'next',
  'wiz.close': 'close',
  'wiz.create': 'bring it to life ✨',
  'wiz.creating': 'growing…',

  'wiz.where.title': 'Where should your brain think?',
  'wiz.where.local': 'On my computer',
  'wiz.where.localSub': 'free · private · needs a decent computer',
  'wiz.where.network': 'In my network',
  'wiz.where.networkSub': 'free · private · Ollama on another machine you own',
  'wiz.where.remote': 'Online',
  'wiz.where.remoteSub': 'uses a paid service · the smartest minds',

  'wiz.net.title': 'Where does Ollama live?',
  'wiz.net.desc': 'Enter the hostname or IP of the machine in your network that runs Ollama (ollama serve) — port and http:// are optional.',
  'wiz.net.ph': '192.168.1.50 or my-pc',
  'wiz.net.hint': 'tip: on that machine, start it with OLLAMA_HOST=0.0.0.0 ollama serve so others can reach it',
  'wiz.net.checking': 'checking…',
  'wiz.net.fail': 'could not reach an Ollama server there — check the address and that “ollama serve” is running',

  'wiz.provider.titleLocal': 'Your local engine',
  'wiz.provider.titleRemote': 'Pick a service',
  'prov.ollama.sub': 'runs free models right on your machine',
  'prov.openrouter.sub': 'one key, hundreds of models',
  'prov.requesty.sub': 'one key, many models — with smart routing',
  'prov.openai.sub': 'the makers of ChatGPT',
  'prov.anthropic.sub': 'the makers of Claude',
  'prov.gemini.sub': 'by Google — has a free tier',
  'prov.mistral.sub': 'European AI, privacy-friendly',
  'prov.xai.sub': 'Grok, by xAI',

  'wiz.key.title': 'Your {provider} key',
  'wiz.key.get': 'get a key ↗',
  'wiz.key.ph': 'paste your key here',
  'wiz.key.safe': '🔒 stored encrypted, on your machine only — never shared',
  'key.desc.openrouter':
    'Create a free account, add a little credit, then create a key. One key unlocks models from many different makers.',
  'key.desc.requesty':
    'Create a free account, add a little credit, then create an API key. One key routes to models from many makers, with automatic fallbacks.',
  'key.desc.openai': 'Sign in, open “API keys”, click “Create new secret key” and copy it here.',
  'key.desc.anthropic': 'Sign in to the console, open “API keys”, create one and copy it here.',
  'key.desc.gemini': 'Sign in with your Google account and click “Create API key” — there is a free tier.',
  'key.desc.mistral': 'Create an account on “La Plateforme”, then create a key under “API keys”.',
  'key.desc.xai': 'Sign in to the xAI console and create an API key.',

  'wiz.model.title': 'Pick a mind',
  'wiz.model.installed': 'already on your machine',
  'wiz.model.installedNet': 'already on that machine',
  'wiz.model.custom': 'something else…',
  'wiz.model.customPh': 'type a model name',
  'wiz.model.pullNote': 'new models are downloaded automatically — the first start can take a few minutes',
  'wiz.model.searchPh': 'search all {provider} models…',
  'wiz.model.searchPhOllama': 'search the Ollama library…',
  'wiz.model.loading': 'fetching the live model list…',
  'wiz.model.noHits': 'nothing found — check the spelling, or use it exactly as typed below',
  'wiz.model.liveFail': 'could not fetch the live list — pick a curated model or use what you typed',
  'wiz.model.useTyped': 'use “{q}”',
  'wiz.model.useTypedSub': 'exactly as typed',
  'wiz.model.library': 'from the Ollama library',
  'wiz.matrix.smart': 'smarter',
  'wiz.matrix.simple': 'simpler',
  'wiz.matrix.cheap': 'cheaper',
  'wiz.matrix.pricey': 'pricier',
  'wiz.matrix.light': 'lighter',
  'wiz.matrix.heavy': 'heavier',
  'tier.recommended': 'recommended',

  'wiz.soul.title': 'Give it a life goal',
  'wiz.soul.goal': 'life goal',
  'wiz.soul.goalPh': 'Keep my GitHub issues tidy and my notes organized. Learn whatever helps.',
  'wiz.soul.goalHint': 'what should this brain care about? plain words are fine',
  'wiz.soul.adoptForced': 'no Docker here — this brain will live in your existing FLUJO instance',
  'wiz.adv': 'advanced',
  'wiz.adv.adopt': 'share the existing FLUJO instance (no own container)',
  'wiz.adv.existing': 'use a model that already exists there',
  'wiz.adv.existingNew': 'no — set up the mind I just chose',
  'wiz.adv.heartbeat': 'wake it up on a schedule',
  'wiz.adv.cron': 'schedule (cron)',
  'wiz.adv.wake': 'first wake right after birth (spends tokens)',
};

const de: Record<string, string> = {
  'app.subtitle': 'jedes Gehirn lebt sein eigenes Leben und verfolgt ein Ziel, das du ihm gibst',
  'lobby.offline': '⚠ der Gehirn-Wärter läuft nicht — starte ihn mit',
  'lobby.adoptMode': '🐳 Docker ist hier nicht verfügbar — neue Gehirne ziehen in dein bestehendes FLUJO unter {url} ein. Stelle sicher, dass es läuft.',

  'orbit.new': 'neues Gehirn',
  'orbit.hint': 'klicke ein Gehirn an, um es zu besuchen — klicke +, um ein neues wachsen zu lassen',
  'orbit.empty': 'noch keine Gehirne — drücke +, um dein erstes wachsen zu lassen',
  'orbit.taken': 'dieses FLUJO beherbergt bereits ein Gehirn',
  'orbit.connect': 'mit einem FLUJO in deinem Netzwerk verbinden',

  'connect.title': 'Mit einem FLUJO in deinem Netzwerk verbinden',
  'connect.desc':
    'Gib die Adresse einer laufenden FLUJO-Instanz ein — ein anderswo gewachsenes Gehirn erscheint direkt in der Lobby; in eine leere Instanz kann eines wachsen.',
  'connect.go': 'verbinden',
  'connect.noStem': 'verbunden — dort gibt es noch keinen Hirnstamm. Öffne es und lass einen wachsen.',

  'status.ready': 'wach',
  'status.idle': 'ruht',
  'status.provisioning': 'wird geboren…',
  'status.error': 'braucht Hilfe',

  'card.open': 'dieses Gehirn öffnen →',
  'card.editor': 'FLUJO-Editor ↗',
  'card.forget': 'vergessen',
  'card.forgetConfirm': '"{name}" vergessen? Sein Zuhause wird entfernt, seine Erinnerungen bleiben erhalten.',
  'card.rebuild': 'neu bauen',
  'card.rebuildConfirm': 'Das Zuhause von "{name}" aus dem aktuellen Image neu bauen? Die Erinnerungen bleiben erhalten — es ist kurz offline.',
  'card.born': 'geboren am {date}',
  'card.noModel': 'noch kein Verstand',
  'card.kind.managed': 'eigenes Zuhause',
  'card.kind.external': 'geteiltes Zuhause',

  'wiz.title': 'ein neues Gehirn wachsen lassen',
  'wiz.back': 'zurück',
  'wiz.next': 'weiter',
  'wiz.close': 'schließen',
  'wiz.create': 'zum Leben erwecken ✨',
  'wiz.creating': 'wächst…',

  'wiz.where.title': 'Wo soll dein Gehirn denken?',
  'wiz.where.local': 'Auf meinem Computer',
  'wiz.where.localSub': 'kostenlos · privat · braucht einen ordentlichen Rechner',
  'wiz.where.network': 'In meinem Netzwerk',
  'wiz.where.networkSub': 'kostenlos · privat · Ollama auf einem anderen Rechner von dir',
  'wiz.where.remote': 'Online',
  'wiz.where.remoteSub': 'nutzt einen Bezahldienst · die klügsten Köpfe',

  'wiz.net.title': 'Wo wohnt Ollama?',
  'wiz.net.desc': 'Gib den Hostnamen oder die IP des Rechners in deinem Netzwerk ein, auf dem Ollama läuft (ollama serve) — Port und http:// sind optional.',
  'wiz.net.ph': '192.168.1.50 oder mein-pc',
  'wiz.net.hint': 'Tipp: starte es dort mit OLLAMA_HOST=0.0.0.0 ollama serve, damit andere Rechner es erreichen',
  'wiz.net.checking': 'prüfe…',
  'wiz.net.fail': 'dort war kein Ollama-Server erreichbar — prüfe die Adresse und ob „ollama serve“ läuft',

  'wiz.provider.titleLocal': 'Dein lokaler Motor',
  'wiz.provider.titleRemote': 'Wähle einen Dienst',
  'prov.ollama.sub': 'führt kostenlose Modelle direkt auf deinem Rechner aus',
  'prov.openrouter.sub': 'ein Schlüssel, hunderte Modelle',
  'prov.requesty.sub': 'ein Schlüssel, viele Modelle — mit intelligentem Routing',
  'prov.openai.sub': 'die Macher von ChatGPT',
  'prov.anthropic.sub': 'die Macher von Claude',
  'prov.gemini.sub': 'von Google — mit Gratis-Stufe',
  'prov.mistral.sub': 'europäische KI, datenschutzfreundlich',
  'prov.xai.sub': 'Grok, von xAI',

  'wiz.key.title': 'Dein {provider}-Schlüssel',
  'wiz.key.get': 'Schlüssel holen ↗',
  'wiz.key.ph': 'füge deinen Schlüssel hier ein',
  'wiz.key.safe': '🔒 verschlüsselt gespeichert, nur auf deinem Rechner — wird nie geteilt',
  'key.desc.openrouter':
    'Erstelle ein kostenloses Konto, lade etwas Guthaben auf und erstelle dann einen Schlüssel. Ein Schlüssel öffnet Modelle vieler verschiedener Anbieter.',
  'key.desc.requesty':
    'Erstelle ein kostenloses Konto, lade etwas Guthaben auf und erstelle dann einen API-Schlüssel. Ein Schlüssel erreicht Modelle vieler Anbieter, mit automatischem Ausweichen.',
  'key.desc.openai': 'Melde dich an, öffne „API keys“, klicke „Create new secret key“ und kopiere ihn hierher.',
  'key.desc.anthropic': 'Melde dich in der Konsole an, öffne „API keys“, erstelle einen und kopiere ihn hierher.',
  'key.desc.gemini': 'Melde dich mit deinem Google-Konto an und klicke „Create API key“ — es gibt eine Gratis-Stufe.',
  'key.desc.mistral': 'Erstelle ein Konto auf „La Plateforme“ und lege dann unter „API keys“ einen Schlüssel an.',
  'key.desc.xai': 'Melde dich in der xAI-Konsole an und erstelle einen API-Schlüssel.',

  'wiz.model.title': 'Wähle einen Verstand',
  'wiz.model.installed': 'bereits auf deinem Rechner',
  'wiz.model.installedNet': 'bereits auf jenem Rechner',
  'wiz.model.custom': 'etwas anderes…',
  'wiz.model.customPh': 'Modellnamen eintippen',
  'wiz.model.pullNote': 'neue Modelle werden automatisch heruntergeladen — der erste Start kann ein paar Minuten dauern',
  'wiz.model.searchPh': 'alle {provider}-Modelle durchsuchen…',
  'wiz.model.searchPhOllama': 'die Ollama-Bibliothek durchsuchen…',
  'wiz.model.loading': 'lade die aktuelle Modellliste…',
  'wiz.model.noHits': 'nichts gefunden — prüfe die Schreibweise oder übernimm sie unten genau so',
  'wiz.model.liveFail': 'Live-Liste nicht erreichbar — wähle ein empfohlenes Modell oder übernimm deine Eingabe',
  'wiz.model.useTyped': '„{q}“ verwenden',
  'wiz.model.useTypedSub': 'genau wie eingetippt',
  'wiz.model.library': 'aus der Ollama-Bibliothek',
  'wiz.matrix.smart': 'schlauer',
  'wiz.matrix.simple': 'einfacher',
  'wiz.matrix.cheap': 'günstiger',
  'wiz.matrix.pricey': 'teurer',
  'wiz.matrix.light': 'leichter',
  'wiz.matrix.heavy': 'schwerer',
  'tier.recommended': 'empfohlen',

  'wiz.soul.title': 'Gib ihm ein Lebensziel',
  'wiz.soul.goal': 'Lebensziel',
  'wiz.soul.goalPh': 'Halte meine GitHub-Issues aufgeräumt und meine Notizen sortiert. Lerne, was dabei hilft.',
  'wiz.soul.goalHint': 'worum soll sich dieses Gehirn kümmern? einfache Worte genügen',
  'wiz.soul.adoptForced': 'kein Docker hier — dieses Gehirn wird in deiner bestehenden FLUJO-Instanz wohnen',
  'wiz.adv': 'erweitert',
  'wiz.adv.adopt': 'die bestehende FLUJO-Instanz mitbenutzen (kein eigener Container)',
  'wiz.adv.existing': 'ein dort bereits vorhandenes Modell verwenden',
  'wiz.adv.existingNew': 'nein — den gerade gewählten Verstand einrichten',
  'wiz.adv.heartbeat': 'nach Zeitplan aufwecken',
  'wiz.adv.cron': 'Zeitplan (Cron)',
  'wiz.adv.wake': 'direkt nach der Geburt zum ersten Mal wecken (verbraucht Tokens)',
};

const es: Record<string, string> = {
  'app.subtitle': 'cada cerebro vive su propia vida, persiguiendo la meta que tú le das',
  'lobby.offline': '⚠ el cuidador de cerebros no está en marcha — inícialo con',
  'lobby.adoptMode': '🐳 Docker no está disponible aquí — los cerebros nuevos se mudan a tu FLUJO existente en {url}. Asegúrate de que esté en marcha.',

  'orbit.new': 'nuevo cerebro',
  'orbit.hint': 'haz clic en un cerebro para visitarlo — haz clic en + para cultivar uno nuevo',
  'orbit.empty': 'aún no hay cerebros — pulsa + para cultivar el primero',
  'orbit.taken': 'este FLUJO ya alberga un cerebro',
  'orbit.connect': 'conectar con un FLUJO en tu red',

  'connect.title': 'Conectar con un FLUJO en tu red',
  'connect.desc':
    'Escribe la dirección de una instancia FLUJO en marcha — un cerebro cultivado en otro lugar entra al vestíbulo tal cual; en una instancia vacía se puede cultivar uno.',
  'connect.go': 'conectar',
  'connect.noStem': 'conectado — aún no hay tronco cerebral ahí. Ábrelo y cultiva uno.',

  'status.ready': 'despierto',
  'status.idle': 'en reposo',
  'status.provisioning': 'naciendo…',
  'status.error': 'necesita ayuda',

  'card.open': 'abrir este cerebro →',
  'card.editor': 'editor FLUJO ↗',
  'card.forget': 'olvidar',
  'card.forgetConfirm': '¿Olvidar "{name}"? Su hogar se elimina, pero sus recuerdos se conservan.',
  'card.rebuild': 'reconstruir',
  'card.rebuildConfirm': '¿Reconstruir el hogar de "{name}" desde la imagen actual? Sus recuerdos se conservan — estará brevemente fuera de línea.',
  'card.born': 'nacido el {date}',
  'card.noModel': 'aún sin mente',
  'card.kind.managed': 'hogar propio',
  'card.kind.external': 'hogar compartido',

  'wiz.title': 'cultivar un nuevo cerebro',
  'wiz.back': 'atrás',
  'wiz.next': 'siguiente',
  'wiz.close': 'cerrar',
  'wiz.create': 'darle vida ✨',
  'wiz.creating': 'creciendo…',

  'wiz.where.title': '¿Dónde debería pensar tu cerebro?',
  'wiz.where.local': 'En mi ordenador',
  'wiz.where.localSub': 'gratis · privado · necesita un equipo decente',
  'wiz.where.network': 'En mi red',
  'wiz.where.networkSub': 'gratis · privado · Ollama en otra máquina tuya',
  'wiz.where.remote': 'En línea',
  'wiz.where.remoteSub': 'usa un servicio de pago · las mentes más brillantes',

  'wiz.net.title': '¿Dónde vive Ollama?',
  'wiz.net.desc': 'Escribe el nombre de host o la IP de la máquina de tu red donde corre Ollama (ollama serve) — el puerto y http:// son opcionales.',
  'wiz.net.ph': '192.168.1.50 o mi-pc',
  'wiz.net.hint': 'consejo: en esa máquina, arráncalo con OLLAMA_HOST=0.0.0.0 ollama serve para que otras puedan alcanzarlo',
  'wiz.net.checking': 'comprobando…',
  'wiz.net.fail': 'no se pudo alcanzar un servidor Ollama ahí — revisa la dirección y que “ollama serve” esté en marcha',

  'wiz.provider.titleLocal': 'Tu motor local',
  'wiz.provider.titleRemote': 'Elige un servicio',
  'prov.ollama.sub': 'ejecuta modelos gratuitos directamente en tu máquina',
  'prov.openrouter.sub': 'una clave, cientos de modelos',
  'prov.requesty.sub': 'una clave, muchos modelos — con enrutado inteligente',
  'prov.openai.sub': 'los creadores de ChatGPT',
  'prov.anthropic.sub': 'los creadores de Claude',
  'prov.gemini.sub': 'de Google — tiene nivel gratuito',
  'prov.mistral.sub': 'IA europea, respetuosa con la privacidad',
  'prov.xai.sub': 'Grok, de xAI',

  'wiz.key.title': 'Tu clave de {provider}',
  'wiz.key.get': 'conseguir una clave ↗',
  'wiz.key.ph': 'pega tu clave aquí',
  'wiz.key.safe': '🔒 guardada cifrada, solo en tu máquina — nunca se comparte',
  'key.desc.openrouter':
    'Crea una cuenta gratuita, añade algo de crédito y crea una clave. Una sola clave desbloquea modelos de muchos fabricantes.',
  'key.desc.requesty':
    'Crea una cuenta gratuita, añade algo de crédito y crea una clave API. Una sola clave llega a modelos de muchos fabricantes, con respaldo automático.',
  'key.desc.openai': 'Inicia sesión, abre “API keys”, pulsa “Create new secret key” y cópiala aquí.',
  'key.desc.anthropic': 'Inicia sesión en la consola, abre “API keys”, crea una y cópiala aquí.',
  'key.desc.gemini': 'Inicia sesión con tu cuenta de Google y pulsa “Create API key” — hay un nivel gratuito.',
  'key.desc.mistral': 'Crea una cuenta en “La Plateforme” y luego crea una clave en “API keys”.',
  'key.desc.xai': 'Inicia sesión en la consola de xAI y crea una clave API.',

  'wiz.model.title': 'Elige una mente',
  'wiz.model.installed': 'ya en tu máquina',
  'wiz.model.installedNet': 'ya en esa máquina',
  'wiz.model.custom': 'otra cosa…',
  'wiz.model.customPh': 'escribe el nombre de un modelo',
  'wiz.model.pullNote': 'los modelos nuevos se descargan automáticamente — el primer arranque puede tardar unos minutos',
  'wiz.model.searchPh': 'busca entre todos los modelos de {provider}…',
  'wiz.model.searchPhOllama': 'busca en la biblioteca de Ollama…',
  'wiz.model.loading': 'obteniendo la lista de modelos en vivo…',
  'wiz.model.noHits': 'nada encontrado — revisa la ortografía o úsalo tal cual abajo',
  'wiz.model.liveFail': 'no se pudo obtener la lista en vivo — elige un modelo recomendado o usa lo que escribiste',
  'wiz.model.useTyped': 'usar «{q}»',
  'wiz.model.useTypedSub': 'exactamente como lo escribiste',
  'wiz.model.library': 'de la biblioteca de Ollama',
  'wiz.matrix.smart': 'más lista',
  'wiz.matrix.simple': 'más simple',
  'wiz.matrix.cheap': 'más barata',
  'wiz.matrix.pricey': 'más cara',
  'wiz.matrix.light': 'más ligera',
  'wiz.matrix.heavy': 'más pesada',
  'tier.recommended': 'recomendada',

  'wiz.soul.title': 'Dale una meta de vida',
  'wiz.soul.goal': 'meta de vida',
  'wiz.soul.goalPh': 'Mantén mis issues de GitHub ordenados y mis notas organizadas. Aprende lo que haga falta.',
  'wiz.soul.goalHint': '¿de qué debería ocuparse este cerebro? con palabras sencillas basta',
  'wiz.soul.adoptForced': 'sin Docker aquí — este cerebro vivirá en tu instancia FLUJO existente',
  'wiz.adv': 'avanzado',
  'wiz.adv.adopt': 'compartir la instancia FLUJO existente (sin contenedor propio)',
  'wiz.adv.existing': 'usar un modelo que ya existe allí',
  'wiz.adv.existingNew': 'no — configurar la mente que acabo de elegir',
  'wiz.adv.heartbeat': 'despertarlo según un horario',
  'wiz.adv.cron': 'horario (cron)',
  'wiz.adv.wake': 'primer despertar justo tras el nacimiento (consume tokens)',
};

const fr: Record<string, string> = {
  'app.subtitle': 'chaque cerveau vit sa propre vie, poursuivant le but que tu lui donnes',
  'lobby.offline': '⚠ le gardien des cerveaux ne tourne pas — lance-le avec',
  'lobby.adoptMode': '🐳 Docker n’est pas disponible ici — les nouveaux cerveaux emménagent dans ton FLUJO existant à {url}. Assure-toi qu’il tourne.',

  'orbit.new': 'nouveau cerveau',
  'orbit.hint': 'clique sur un cerveau pour le visiter — clique sur + pour en faire pousser un nouveau',
  'orbit.empty': 'pas encore de cerveau — appuie sur + pour faire pousser le premier',
  'orbit.taken': 'ce FLUJO héberge déjà un cerveau',
  'orbit.connect': 'se connecter à un FLUJO sur ton réseau',

  'connect.title': 'Se connecter à un FLUJO sur ton réseau',
  'connect.desc':
    'Saisis l’adresse d’une instance FLUJO en marche — un cerveau qui a poussé ailleurs rejoint le hall tel quel ; une instance vide peut en faire pousser un.',
  'connect.go': 'connecter',
  'connect.noStem': 'connecté — pas encore de tronc cérébral là-bas. Ouvre-le et fais-en pousser un.',

  'status.ready': 'éveillé',
  'status.idle': 'au repos',
  'status.provisioning': 'en train de naître…',
  'status.error': 'a besoin d’aide',

  'card.open': 'ouvrir ce cerveau →',
  'card.editor': 'éditeur FLUJO ↗',
  'card.forget': 'oublier',
  'card.forgetConfirm': 'Oublier « {name} » ? Son foyer est supprimé, mais ses souvenirs sont conservés.',
  'card.rebuild': 'reconstruire',
  'card.rebuildConfirm': 'Reconstruire le foyer de « {name} » depuis l’image actuelle ? Ses souvenirs sont conservés — il sera brièvement hors ligne.',
  'card.born': 'né le {date}',
  'card.noModel': 'pas encore d’esprit',
  'card.kind.managed': 'son propre foyer',
  'card.kind.external': 'foyer partagé',

  'wiz.title': 'faire pousser un nouveau cerveau',
  'wiz.back': 'retour',
  'wiz.next': 'suivant',
  'wiz.close': 'fermer',
  'wiz.create': 'lui donner vie ✨',
  'wiz.creating': 'pousse…',

  'wiz.where.title': 'Où ton cerveau doit-il réfléchir ?',
  'wiz.where.local': 'Sur mon ordinateur',
  'wiz.where.localSub': 'gratuit · privé · demande un ordinateur correct',
  'wiz.where.network': 'Sur mon réseau',
  'wiz.where.networkSub': 'gratuit · privé · Ollama sur une autre machine à toi',
  'wiz.where.remote': 'En ligne',
  'wiz.where.remoteSub': 'via un service payant · les esprits les plus brillants',

  'wiz.net.title': 'Où vit Ollama ?',
  'wiz.net.desc': 'Saisis le nom d’hôte ou l’IP de la machine de ton réseau qui fait tourner Ollama (ollama serve) — le port et http:// sont facultatifs.',
  'wiz.net.ph': '192.168.1.50 ou mon-pc',
  'wiz.net.hint': 'astuce : sur cette machine, lance-le avec OLLAMA_HOST=0.0.0.0 ollama serve pour qu’elle soit joignable',
  'wiz.net.checking': 'vérification…',
  'wiz.net.fail': 'aucun serveur Ollama joignable à cette adresse — vérifie l’adresse et que « ollama serve » tourne',

  'wiz.provider.titleLocal': 'Ton moteur local',
  'wiz.provider.titleRemote': 'Choisis un service',
  'prov.ollama.sub': 'fait tourner des modèles gratuits directement sur ta machine',
  'prov.openrouter.sub': 'une clé, des centaines de modèles',
  'prov.requesty.sub': 'une clé, de nombreux modèles — avec routage intelligent',
  'prov.openai.sub': 'les créateurs de ChatGPT',
  'prov.anthropic.sub': 'les créateurs de Claude',
  'prov.gemini.sub': 'par Google — avec une offre gratuite',
  'prov.mistral.sub': 'IA européenne, respectueuse de la vie privée',
  'prov.xai.sub': 'Grok, par xAI',

  'wiz.key.title': 'Ta clé {provider}',
  'wiz.key.get': 'obtenir une clé ↗',
  'wiz.key.ph': 'colle ta clé ici',
  'wiz.key.safe': '🔒 stockée chiffrée, uniquement sur ta machine — jamais partagée',
  'key.desc.openrouter':
    'Crée un compte gratuit, ajoute un peu de crédit, puis crée une clé. Une seule clé ouvre des modèles de nombreux fabricants.',
  'key.desc.requesty':
    'Crée un compte gratuit, ajoute un peu de crédit, puis crée une clé API. Une seule clé atteint des modèles de nombreux fabricants, avec bascule automatique.',
  'key.desc.openai': 'Connecte-toi, ouvre « API keys », clique « Create new secret key » et copie-la ici.',
  'key.desc.anthropic': 'Connecte-toi à la console, ouvre « API keys », crées-en une et copie-la ici.',
  'key.desc.gemini': 'Connecte-toi avec ton compte Google et clique « Create API key » — il existe une offre gratuite.',
  'key.desc.mistral': 'Crée un compte sur « La Plateforme », puis crée une clé sous « API keys ».',
  'key.desc.xai': 'Connecte-toi à la console xAI et crée une clé API.',

  'wiz.model.title': 'Choisis un esprit',
  'wiz.model.installed': 'déjà sur ta machine',
  'wiz.model.installedNet': 'déjà sur cette machine',
  'wiz.model.custom': 'autre chose…',
  'wiz.model.customPh': 'tape le nom d’un modèle',
  'wiz.model.pullNote': 'les nouveaux modèles se téléchargent automatiquement — le premier démarrage peut prendre quelques minutes',
  'wiz.model.searchPh': 'chercher parmi tous les modèles {provider}…',
  'wiz.model.searchPhOllama': 'chercher dans la bibliothèque Ollama…',
  'wiz.model.loading': 'récupération de la liste des modèles…',
  'wiz.model.noHits': 'rien trouvé — vérifie l’orthographe ou utilise-le tel quel ci-dessous',
  'wiz.model.liveFail': 'liste en direct indisponible — choisis un modèle recommandé ou utilise ce que tu as tapé',
  'wiz.model.useTyped': 'utiliser « {q} »',
  'wiz.model.useTypedSub': 'exactement comme tapé',
  'wiz.model.library': 'de la bibliothèque Ollama',
  'wiz.matrix.smart': 'plus malin',
  'wiz.matrix.simple': 'plus simple',
  'wiz.matrix.cheap': 'moins cher',
  'wiz.matrix.pricey': 'plus cher',
  'wiz.matrix.light': 'plus léger',
  'wiz.matrix.heavy': 'plus lourd',
  'tier.recommended': 'recommandé',

  'wiz.soul.title': 'Donne-lui un but de vie',
  'wiz.soul.goal': 'but de vie',
  'wiz.soul.goalPh': 'Garde mes issues GitHub triées et mes notes organisées. Apprends ce qui peut aider.',
  'wiz.soul.goalHint': 'de quoi ce cerveau doit-il se soucier ? des mots simples suffisent',
  'wiz.soul.adoptForced': 'pas de Docker ici — ce cerveau vivra dans ton instance FLUJO existante',
  'wiz.adv': 'avancé',
  'wiz.adv.adopt': 'partager l’instance FLUJO existante (pas de conteneur dédié)',
  'wiz.adv.existing': 'utiliser un modèle qui y existe déjà',
  'wiz.adv.existingNew': 'non — installer l’esprit que je viens de choisir',
  'wiz.adv.heartbeat': 'le réveiller selon un horaire',
  'wiz.adv.cron': 'horaire (cron)',
  'wiz.adv.wake': 'premier réveil juste après la naissance (consomme des tokens)',
};

const DICTS: Record<Lang, Record<string, string>> = { en, de, es, fr };

const STORAGE_KEY = 'brain.lang';

function detectLang(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY) as Lang | null;
  if (stored && stored in DICTS) return stored;
  const nav = navigator.language.slice(0, 2).toLowerCase();
  return (nav in DICTS ? nav : 'en') as Lang;
}

let current: Lang = detectLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  listeners.forEach((fn) => fn());
}

export function onLangChange(fn: () => void): void {
  listeners.add(fn);
}

export function t(key: string, vars?: Record<string, string>): string {
  let s = DICTS[current][key] ?? DICTS.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  return s;
}

/** Fill every [data-i18n] / [data-i18n-ph] element under `root`. */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh!);
  });
}
