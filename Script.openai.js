// Clash Verge Rev global extension script.
// The selector remains complete; controller.mjs owns health checks and switching.

function main(config, profileName) {
  const groupName = "OpenAI 自动选择";
  const supportedRegion =
    /(^|[^A-Za-z])(SG|JP|US|TW|KR)([^A-Za-z]|$)|新加坡|日本|美国|台湾|韩国|Singapore|Japan|United States|Taiwan|Korea/i;

  const candidates = (config.proxies || [])
    .map((proxy) => proxy.name)
    .filter((name) => name && supportedRegion.test(name));

  if (candidates.length === 0) return config;

  const groups = Array.isArray(config["proxy-groups"])
    ? config["proxy-groups"]
    : [];
  config["proxy-groups"] = groups.filter((group) => group.name !== groupName);

  // Avoid a selector race: Mihomo does not auto-switch this group.
  config["proxy-groups"].push({
    name: groupName,
    type: "select",
    proxies: candidates,
  });

  const probeNodes = [...new Set(candidates)].sort();
  const probeBasePort = 17900;
  const listenerPrefix = "openai-route-probe-";
  const listeners = (Array.isArray(config.listeners) ? config.listeners : [])
    .filter((listener) => !listener.name?.startsWith(listenerPrefix));
  for (const [index, name] of probeNodes.entries()) {
    const port = probeBasePort + index;
    if (listeners.some((listener) => Number(listener.port) === port)) {
      throw new Error(`OpenAI probe port ${port} is already configured`);
    }
    listeners.push({
      name: `${listenerPrefix}${index}`,
      type: "mixed",
      listen: "127.0.0.1",
      port,
      udp: false,
      users: [],
      proxy: name,
    });
  }
  config.listeners = listeners;

  config.profile = {
    ...(config.profile || {}),
    "store-selected": true,
  };

  const openAIRules = [
    `DOMAIN-SUFFIX,openai.com,${groupName}`,
    `DOMAIN-SUFFIX,chatgpt.com,${groupName}`,
    `DOMAIN-SUFFIX,oaistatic.com,${groupName}`,
    `DOMAIN-SUFFIX,oaiusercontent.com,${groupName}`,
  ];
  const oldRules = Array.isArray(config.rules) ? config.rules : [];
  config.rules = openAIRules.concat(
    oldRules.filter((rule) => !openAIRules.includes(rule)),
  );

  return config;
}
