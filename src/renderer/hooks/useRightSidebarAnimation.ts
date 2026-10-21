import { useEffect, useRef, useState, type RefObject } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

export function useRightSidebarAnimation(panelRef: RefObject<HTMLElement | null>, expanded: boolean) {
  const animationRef = useRef<gsap.core.Timeline | null>(null);
  const previousExpanded = useRef(expanded);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const resize = () => setViewportWidth(window.innerWidth);
    const motion = () => setReducedMotion(media.matches);
    window.addEventListener('resize', resize);
    media.addEventListener('change', motion);
    return () => {
      window.removeEventListener('resize', resize);
      media.removeEventListener('change', motion);
    };
  }, []);

  useGSAP(() => {
    const panel = panelRef.current;
    const content = panel?.querySelector<HTMLElement>('.right-sidebar-tools');
    if (!panel || !content) return;

    const wasExpanded = previousExpanded.current;
    const toggled = wasExpanded !== expanded;
    previousExpanded.current = expanded;
    animationRef.current?.kill();

    const expandedWidth = content.getBoundingClientRect().width;
    // Preserve the last painted width across React class changes and interrupted
    // tweens. After a hot reload, fall back to the previous logical state.
    const currentWidth = panel.style.width ? parseFloat(panel.style.width) : wasExpanded ? expandedWidth : 0;
    gsap.set(panel, { width: currentWidth, visibility: 'visible' });

    if (reducedMotion || !toggled) {
      gsap.set(panel, { width: expanded ? expandedWidth : 0, visibility: expanded ? 'visible' : 'hidden' });
      gsap.set(content, { autoAlpha: expanded ? 1 : 0, x: expanded ? 0 : 20 });
      return;
    }

    // Create a fresh transition for every interaction instead of replaying a
    // paused timeline that can be reverted by development-mode lifecycle changes.
    const animation = gsap.timeline({
      onComplete: () => {
        panel.style.visibility = expanded ? 'visible' : 'hidden';
      },
    });
    animationRef.current = animation;
    animation.to(panel, {
      width: expanded ? expandedWidth : 0,
      duration: expanded ? 0.4 : 0.3,
      ease: expanded ? 'power2.out' : 'power2.inOut',
      overwrite: 'auto',
    }, 0).to(content, {
      autoAlpha: expanded ? 1 : 0,
      x: expanded ? 0 : 20,
      duration: expanded ? 0.32 : 0.16,
      ease: 'power1.out',
      overwrite: 'auto',
    }, 0);
  }, { scope: panelRef, dependencies: [expanded, viewportWidth, reducedMotion] });
}
