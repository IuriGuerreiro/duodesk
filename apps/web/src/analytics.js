export const analyticsConfig = {
  scriptUrl: 'https://pulse.elorenlabs.com/lib.js',
  websiteId: 'c37a8172-228c-4f63-8b7e-7638431396bd',
  domains: 'doudesk.elorenlabs.com',
};

export function loadAnalytics() {
  const script = document.createElement('script');
  script.async = true;
  script.defer = true;
  script.src = analyticsConfig.scriptUrl;
  script.setAttribute('data-website-id', analyticsConfig.websiteId);
  script.setAttribute('data-domains', analyticsConfig.domains);
  document.head.appendChild(script);
}
