/** A small picture of what a tool does, for its card in Herramientas on desktop.
 * Drawn in the card's section colour (`currentColor`) on its tint; purely decorative. */
const Page = ({
  x,
  y,
  w = 44,
  h = 58,
  tilt = 0,
  lines = 3,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  tilt?: number;
  lines?: number;
}) => (
  <g transform={`rotate(${tilt} ${x + w / 2} ${y + h / 2})`}>
    <rect x={x} y={y} width={w} height={h} rx={4} fill="#fff" stroke="#14182014" />
    <rect x={x + 7} y={y + 8} width={w * 0.5} height={4} rx={2} fill="#b8bec8" />
    {Array.from({ length: lines }, (_, i) => (
      <rect key={i} x={x + 7} y={y + 18 + i * 8} width={w - 14 - (i % 2) * 8} height={3} rx={1.5} fill="#d6dae0" />
    ))}
  </g>
);

export default function ToolArt({ tool }: { tool: string }) {
  let scene: React.ReactNode;
  switch (tool) {
    case 'pages':
      scene = (
        <>
          <Page x={22} y={30} w={34} h={46} />
          <Page x={62} y={16} w={34} h={46} tilt={-8} />
          <rect x={102} y={28} width={3} height={50} rx={1.5} fill="currentColor" />
          <Page x={112} y={30} w={34} h={46} />
          <Page x={152} y={30} w={34} h={46} />
        </>
      );
      break;
    case 'split':
      scene = (
        <>
          <Page x={52} y={22} tilt={-6} />
          <line x1={100} y1={14} x2={100} y2={92} stroke="currentColor" strokeWidth={2} strokeDasharray="5 4" />
          <circle cx={100} cy={53} r={12} fill="currentColor" />
          <path d="M95 48l10 10M105 48l-10 10" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
          <Page x={104} y={22} tilt={6} />
        </>
      );
      break;
    case 'crop':
      scene = (
        <>
          <Page x={70} y={12} w={60} h={78} lines={5} />
          <path d="M70 12h60v78H70z M80 22v58h40V22z" fill="currentColor" opacity={0.16} fillRule="evenodd" />
          <path d="M78 30v-8h8M122 30v-8h-8M78 72v8h8M122 72v8h-8" stroke="currentColor" strokeWidth={3} fill="none" />
        </>
      );
      break;
    case 'edit-pdf':
      scene = (
        <>
          <Page x={60} y={14} w={80} h={74} lines={5} />
          <rect x={64} y={30} width={60} height={16} rx={2} fill="none" stroke="currentColor" strokeWidth={2} />
          <rect x={118} y={33} width={2} height={10} fill="#1f2430" />
        </>
      );
      break;
    case 'remove-image':
      scene = (
        <>
          <Page x={60} y={14} w={80} h={74} lines={1} />
          <rect x={68} y={34} width={64} height={34} rx={3} fill="currentColor" opacity={0.3} />
          <circle cx={100} cy={51} r={11} fill="currentColor" />
          <path d="M95 46l10 10M105 46l-10 10" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
        </>
      );
      break;
    case 'forms':
      scene = (
        <>
          <rect x={50} y={16} width={100} height={72} rx={6} fill="#fff" />
          <rect x={60} y={26} width={80} height={13} rx={3} fill="none" stroke="currentColor" strokeWidth={1.5} />
          <rect x={64} y={31} width={30} height={3} rx={1.5} fill="#1f2430" />
          <rect x={60} y={45} width={80} height={13} rx={3} fill="#f4f6f8" stroke="#cdd3da" />
          <rect x={60} y={66} width={10} height={10} rx={2} fill="currentColor" />
          <path d="M62 71l2 2 4-4" stroke="#fff" strokeWidth={1.6} fill="none" strokeLinecap="round" />
          <rect x={76} y={69} width={34} height={3} rx={1.5} fill="#b8bec8" />
        </>
      );
      break;
    case 'create-field':
      scene = (
        <>
          <Page x={56} y={14} w={88} h={74} lines={3} />
          <rect
            x={64}
            y={58}
            width={60}
            height={16}
            rx={2}
            fill="currentColor"
            fillOpacity={0.1}
            stroke="currentColor"
            strokeWidth={2}
            strokeDasharray="4 3"
          />
          <circle cx={130} cy={56} r={9} fill="currentColor" />
          <path d="M130 52v8M126 56h8" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
        </>
      );
      break;
    case 'compare':
      scene = (
        <>
          <g>
            <rect x={48} y={18} width={48} height={66} rx={4} fill="#fff" />
            <rect x={55} y={28} width={30} height={3} rx={1.5} fill="#d6dae0" />
            <rect x={55} y={38} width={34} height={4} rx={2} fill="#f2b8ae" />
            <rect x={55} y={48} width={28} height={3} rx={1.5} fill="#d6dae0" />
          </g>
          <g>
            <rect x={104} y={18} width={48} height={66} rx={4} fill="#fff" />
            <rect x={111} y={28} width={30} height={3} rx={1.5} fill="#d6dae0" />
            <rect x={111} y={38} width={34} height={4} rx={2} fill="#9fd6b4" />
            <rect x={111} y={48} width={24} height={4} rx={2} fill="#9fd6b4" />
          </g>
        </>
      );
      break;
    case 'signatures':
      scene = (
        <>
          <rect x={44} y={22} width={112} height={58} rx={6} fill="#fff" />
          <path
            d="M56 62c8-12 14-22 20-19 4 2-6 20 0 20 5 0 8-12 14-12 5 0 2 10 8 10s9-9 15-9 8 6 14 6"
            fill="none"
            stroke="#1f2430"
            strokeWidth={2}
            strokeLinecap="round"
          />
          <line x1={54} y1={70} x2={146} y2={70} stroke="#a3aab6" strokeWidth={1} />
          <circle cx={152} cy={24} r={11} fill="#1f7a4a" />
          <path d="M147 24l3 3 6-6" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" />
        </>
      );
      break;
    case 'convert':
      scene = (
        <>
          <rect x={40} y={26} width={36} height={46} rx={4} fill="#b0473a" />
          <text x={58} y={64} textAnchor="middle" fontSize={9} fontWeight={700} fill="#fff">
            PDF
          </text>
          <path d="M84 49h20M98 43l6 6-6 6" stroke="currentColor" strokeWidth={2.4} fill="none" strokeLinecap="round" />
          <rect x={112} y={24} width={34} height={22} rx={4} fill="#2f5bd3" />
          <text x={129} y={38} textAnchor="middle" fontSize={8} fontWeight={700} fill="#fff">
            DOCX
          </text>
          <rect x={112} y={52} width={34} height={22} rx={4} fill="#5c6575" />
          <text x={129} y={66} textAnchor="middle" fontSize={8} fontWeight={700} fill="#fff">
            TXT
          </text>
          <rect x={152} y={28} width={22} height={42} rx={4} fill="#6f9466" />
        </>
      );
      break;
    case 'ocr':
      scene = (
        <>
          <g transform="rotate(-4 100 52)">
            <rect x={66} y={12} width={68} height={82} rx={4} fill="#f3efe6" />
            <rect x={74} y={22} width={30} height={5} rx={2} fill="#8f949c" />
            <rect
              x={74}
              y={34}
              width={30}
              height={7}
              rx={2}
              fill="currentColor"
              fillOpacity={0.14}
              stroke="currentColor"
              strokeWidth={1.4}
            />
            <rect
              x={108}
              y={34}
              width={18}
              height={7}
              rx={2}
              fill="currentColor"
              fillOpacity={0.14}
              stroke="currentColor"
              strokeWidth={1.4}
            />
            <rect
              x={74}
              y={46}
              width={20}
              height={7}
              rx={2}
              fill="currentColor"
              fillOpacity={0.14}
              stroke="currentColor"
              strokeWidth={1.4}
            />
            <rect
              x={98}
              y={46}
              width={28}
              height={7}
              rx={2}
              fill="currentColor"
              fillOpacity={0.14}
              stroke="currentColor"
              strokeWidth={1.4}
            />
            <rect x={74} y={60} width={52} height={3} rx={1.5} fill="#b9bdc4" />
            <rect x={74} y={68} width={44} height={3} rx={1.5} fill="#b9bdc4" />
          </g>
        </>
      );
      break;
    case 'compress':
      scene = (
        <>
          <Page x={48} y={14} w={50} h={64} />
          <text x={73} y={92} textAnchor="middle" fontSize={9} fontWeight={700} fill="#5c6575">
            48 MB
          </text>
          <path
            d="M106 46h18M118 40l6 6-6 6"
            stroke="currentColor"
            strokeWidth={2.4}
            fill="none"
            strokeLinecap="round"
          />
          <Page x={132} y={36} w={30} h={40} lines={2} />
          <text x={147} y={92} textAnchor="middle" fontSize={9} fontWeight={700} fill="currentColor">
            14 MB
          </text>
        </>
      );
      break;
    case 'redact':
      scene = (
        <>
          <rect x={52} y={16} width={96} height={72} rx={4} fill="#fff" />
          <rect x={60} y={26} width={44} height={5} rx={2} fill="#b8bec8" />
          <rect x={60} y={40} width={28} height={3} rx={1.5} fill="#d6dae0" />
          <rect x={92} y={37} width={46} height={9} rx={1} fill="#111" />
          <rect x={60} y={54} width={78} height={3} rx={1.5} fill="#d6dae0" />
          <rect x={60} y={64} width={36} height={9} rx={1} fill="#111" />
          <rect x={100} y={67} width={38} height={3} rx={1.5} fill="#d6dae0" />
        </>
      );
      break;
    case 'security':
      scene = (
        <>
          <Page x={72} y={12} w={56} h={76} lines={5} />
          <rect x={84} y={34} width={32} height={32} rx={9} fill="currentColor" />
          <path
            d="M93 49h14v10H93zM96 49v-4a4 4 0 0 1 8 0v4"
            stroke="#fff"
            strokeWidth={2}
            fill="none"
            strokeLinejoin="round"
          />
        </>
      );
      break;
    case 'sanitize':
      scene = (
        <>
          <Page x={56} y={14} w={56} h={74} lines={4} />
          {['Autor', 'Adjuntos', 'Scripts'].map((label, i) => (
            <g key={label}>
              <rect x={118} y={20 + i * 20} width={52} height={14} rx={7} fill="#fff" stroke="#14182014" />
              <text
                x={144}
                y={30 + i * 20}
                textAnchor="middle"
                fontSize={8}
                fontWeight={700}
                fill="#8a919c"
                textDecoration="line-through"
              >
                {label}
              </text>
            </g>
          ))}
          <circle cx={58} cy={80} r={11} fill="currentColor" />
          <path d="M53 80l3 3 6-6" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" />
        </>
      );
      break;
    default:
      return null;
  }
  return (
    <svg className="tool-art" viewBox="0 0 200 104" aria-hidden="true" focusable="false">
      {scene}
    </svg>
  );
}
