import type { PageViewport } from 'pdfjs-dist';
import type { Annotation } from '../types';

// Folio's shape annotations, drawn over the page like its highlights and ink.

export function ShapeSvg({ viewport, shapes, className = 'shape-layer' }: { viewport: PageViewport; shapes: Annotation[]; className?: string }) {
  const scale = viewport.scale;
  return <svg className={className} width={viewport.width} height={viewport.height} aria-hidden="true">
    {shapes.map(shape => {
      const width = Math.max(.5, (shape.strokeWidth ?? 1) * scale), common = { stroke: shape.strokeWidth ? shape.color : 'none', strokeWidth: width, opacity: shape.opacity ?? 1 };
      if (shape.line) {
        const [x1, y1] = viewport.convertToViewportPoint(shape.line[0], shape.line[1]), [x2, y2] = viewport.convertToViewportPoint(shape.line[2], shape.line[3]);
        const angle = Math.atan2(y2 - y1, x2 - x1), head = Math.max(8 * scale, width * 4);
        const wing = (side: number) => `${x2 - head * Math.cos(angle + side * Math.PI / 6)},${y2 - head * Math.sin(angle + side * Math.PI / 6)}`;
        return <g key={shape.id} {...common} fill="none" strokeLinecap="round" strokeLinejoin="round">
          <line x1={x1} y1={y1} x2={x2} y2={y2} />
          {shape.shape === 'arrow' && <polyline points={`${wing(1)} ${x2},${y2} ${wing(-1)}`} />}
        </g>;
      }
      const a = viewport.convertToViewportPoint(shape.rect[0], shape.rect[1]), b = viewport.convertToViewportPoint(shape.rect[2], shape.rect[3]);
      const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(a[0] - b[0]), h = Math.abs(a[1] - b[1]), fill = shape.fill || 'none';
      // The border is drawn inside the shape's box, as in the saved PDF.
      const inset = Math.min(width / 2, w / 2, h / 2);
      return shape.shape === 'ellipse'
        ? <ellipse key={shape.id} {...common} fill={fill} cx={x + w / 2} cy={y + h / 2} rx={Math.max(0, w / 2 - inset)} ry={Math.max(0, h / 2 - inset)} />
        : <rect key={shape.id} {...common} fill={fill} x={x + inset} y={y + inset} width={Math.max(0, w - 2 * inset)} height={Math.max(0, h - 2 * inset)} />;
    })}
  </svg>;
}
