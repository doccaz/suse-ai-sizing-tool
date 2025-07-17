import React, { useState, useMemo, useEffect } from 'react';
import { Cpu, MemoryStick, HardDrive, Network, FileDown, CheckCircle, XCircle, Info, Layers, AlertTriangle, Server, Bot, ShieldCheck, Database, BarChart3, Container, Archive, Globe, ExternalLink } from 'lucide-react';

// --- Data Structures ---

const baseComponentData = {
  controlPlane: {
    name: 'Control Plane Nodes',
    profiles: {
      default: { name: 'Default', cpu: 8, ram: 32, storage: 200, storageNote: "High-speed storage (SSD/NVMe) is strongly recommended for etcd performance." },
    },
  },
  gpuWorkerNodes: {
    name: 'GPU-Enabled Worker Nodes',
    profiles: {
      default: { name: 'Default GPU Profile', cpu: 16, ram: 32, storage: 250 },
    },
  },
  generalWorkerNodes: {
    name: 'General Purpose Worker Nodes',
    profiles: {
      default: { name: 'Default General Profile', cpu: 8, ram: 64, storage: 100 },
    },
  },
};

const servicesData = {
  suseSecurity: {
    name: 'SUSE Security (Neuvector)',
    icon: <ShieldCheck className="w-5 h-5 mr-2" />,
    description: "Runtime security platform providing vulnerability scanning, threat detection, and firewalling for containers.",
    profiles: {
      default: { name: 'Default', cpu: 4, ram: 4, storage: 20 },
    }
  },
  suseStorage: {
    name: 'SUSE Storage (Longhorn)',
    icon: <Archive className="w-5 h-5 mr-2" />,
    description: "Cloud-native, distributed block storage for Kubernetes. Provides persistent, replicated storage for stateful applications.",
    profiles: {
        default: { name: 'Default (3-Node Management Plane)', cpu: 12, ram: 12, storage: 0, storageNote: "Storage is managed on worker nodes, not consumed here. Requires 10Gbps network." },
    }
  },
  privateRegistry: {
    name: 'SUSE Private Registry',
    icon: <Container className="w-5 h-5 mr-2" />,
    description: "Secure, private OCI-compliant registry for storing and distributing container images and Helm charts. Based on Harbor.",
    profiles: {
        default: { name: 'Default', cpu: 2, ram: 4, storage: 100, storageNote: "Based on Harbor. Storage depends on image count." },
    }
  },
  milvus: {
    name: 'Milvus Vector DB',
    icon: <Database className="w-5 h-5 mr-2" />,
    description: "An open-source vector database built for AI applications, enabling efficient similarity search on massive-scale vector datasets.",
    profiles: {
      minimal: { name: 'Minimal', cpu: 8, ram: 32, storage: 100 },
      recommended: { name: 'Recommended', cpu: 16, ram: 64, storage: 500 },
    }
  },
  ollama: {
    name: 'Ollama',
    icon: <Bot className="w-5 h-5 mr-2" />,
    description: "A tool for running large language models (LLMs) locally. Simplifies downloading and serving models like Llama 2.",
    profiles: {
      default: { name: 'Default (GPU Required)', cpu: 8, ram: 32, storage: 50, gpu: 1 },
    }
  },
  openWebUI: {
    name: 'OpenWebUI',
    icon: <Globe className="w-5 h-5 mr-2" />,
    description: "A user-friendly, ChatGPT-style web interface for interacting with local LLMs served by tools like Ollama.",
    profiles: {
        default: { name: 'Default', cpu: 2, ram: 4, storage: 10 },
    }
  },
  observability: {
    name: 'SUSE Observability',
    icon: <BarChart3 className="w-5 h-5 mr-2" />,
    description: "A comprehensive monitoring solution for collecting metrics, logs, and traces to provide insight into cluster and application performance.",
    profiles: {
      '10_non_ha': { name: 'Up to 10 nodes (non-HA)', cpu: 4, ram: 16, storage: 50 },
      '10_ha': { name: 'Up to 10 nodes (HA)', cpu: 4, ram: 16, storage: 50 },
      '20_non_ha': { name: 'Up to 20 nodes (non-HA)', cpu: 8, ram: 32, storage: 100 },
      '20_ha': { name: 'Up to 20 nodes (HA)', cpu: 8, ram: 32, storage: 100 },
      '50_non_ha': { name: 'Up to 50 nodes (non-HA)', cpu: 16, ram: 64, storage: 200 },
      '50_ha': { name: 'Up to 50 nodes (HA)', cpu: 16, ram: 64, storage: 200 },
      '100_non_ha': { name: 'Up to 100 nodes (non-HA)', cpu: 32, ram: 128, storage: 500 },
      '100_ha': { name: 'Up to 100 nodes (HA)', cpu: 32, ram: 128, storage: 500 },
    },
  },
};

const networkData = {
  rancher: { name: 'SUSE Rancher Prime', ports: [ { port: 'TCP/443', service: 'Rancher UI/API', source: 'All Users/Nodes', destination: 'Control Plane LB' }, { port: 'TCP/6443', service: 'Kubernetes API', source: 'All Nodes', destination: 'Control Plane Nodes' } ] },
  clusterInternal: { name: 'Core Kubernetes', ports: [ { port: 'TCP/2379-2380', service: 'etcd', source: 'Control Plane Nodes', destination: 'Each Other' }, { port: 'TCP/10250', service: 'Kubelet API', source: 'Control Plane', destination: 'All Nodes' }, { port: 'UDP/8472', service: 'Canal/Flannel VXLAN', source: 'All Nodes', destination: 'Each Other' } ] },
  suseSecurity: { name: 'SUSE Security (Neuvector)', ports: [ { port: 'TCP/18300-18301', service: 'Controller/Enforcer Comms', source: 'NeuVector Pods', destination: 'Each Other' } ] },
  suseStorage: { name: 'SUSE Storage (Longhorn)', ports: [ { port: 'TCP/9500', service: 'Longhorn Manager', source: 'Internal', destination: 'Longhorn Nodes' }, { port: 'TCP/3260', service: 'iSCSI Target', source: 'Kubelet', destination: 'Longhorn Nodes' } ] },
  privateRegistry: { name: 'SUSE Private Registry', ports: [ { port: 'TCP/443', service: 'Registry UI & API', source: 'Users & Nodes', destination: 'Ingress' }, { port: 'TCP/4443', service: 'Trivy Scanner', source: 'Registry', destination: 'Internal' } ] },
  observability: { name: 'SUSE Observability', ports: [ { port: 'TCP/3000', service: 'Grafana', source: 'Users', destination: 'Ingress' }, { port: 'TCP/9090', service: 'Prometheus', source: 'Users', destination: 'Ingress' } ] },
};

// --- Main App Component ---
export default function App() {
  const [activeTab, setActiveTab] = useState('sizing');
  const [pdfReady, setPdfReady] = useState(false);
  
  const [baseSelections, setBaseSelections] = useState({
    controlPlane: { profile: 'default', nodes: 3 },
    gpuWorkerNodes: { profile: 'default', nodes: 1, gpus: 1 },
    generalWorkerNodes: { profile: 'default', nodes: 1 },
  });

  const [serviceSelections, setServiceSelections] = useState({
    suseSecurity: { selected: false, profile: 'default' },
    suseStorage: { selected: false, profile: 'default' },
    privateRegistry: { selected: false, profile: 'default' },
    milvus: { selected: false, profile: 'minimal' },
    ollama: { selected: false, profile: 'default' },
    openWebUI: { selected: false, profile: 'default' },
    observability: { selected: false, profile: '20_ha' },
  });

  useEffect(() => {
    const loadScript = (src) => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve(script);
      script.onerror = () => reject(new Error(`Script load error for ${src}`));
      document.body.appendChild(script);
    });

    loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
      .then(() => loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'))
      .then(() => setPdfReady(true))
      .catch(error => console.error("Failed to load PDF libraries", error));
  }, []);

  const handleBaseChange = (id, field, value) => {
    setBaseSelections(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const handleServiceChange = (id, field, value) => {
    setServiceSelections(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const summary = useMemo(() => {
    const baseCapacity = { cpu: 0, ram: 0, storage: 0, gpu: 0 };
    const servicesDemand = { cpu: 0, ram: 0, storage: 0, gpu: 0 };

    // Control Plane
    const cpProfile = baseComponentData.controlPlane.profiles[baseSelections.controlPlane.profile];
    baseCapacity.cpu += cpProfile.cpu * baseSelections.controlPlane.nodes;
    baseCapacity.ram += cpProfile.ram * baseSelections.controlPlane.nodes;
    baseCapacity.storage += cpProfile.storage * baseSelections.controlPlane.nodes;
    
    // GPU Workers
    const gpuWnProfile = baseComponentData.gpuWorkerNodes.profiles[baseSelections.gpuWorkerNodes.profile];
    baseCapacity.cpu += gpuWnProfile.cpu * baseSelections.gpuWorkerNodes.nodes;
    baseCapacity.ram += gpuWnProfile.ram * baseSelections.gpuWorkerNodes.nodes;
    baseCapacity.storage += gpuWnProfile.storage * baseSelections.gpuWorkerNodes.nodes;
    baseCapacity.gpu = baseSelections.gpuWorkerNodes.gpus;

    // General Workers
    const genWnProfile = baseComponentData.generalWorkerNodes.profiles[baseSelections.generalWorkerNodes.profile];
    baseCapacity.cpu += genWnProfile.cpu * baseSelections.generalWorkerNodes.nodes;
    baseCapacity.ram += genWnProfile.ram * baseSelections.generalWorkerNodes.nodes;
    baseCapacity.storage += genWnProfile.storage * baseSelections.generalWorkerNodes.nodes;

    const selectedServicesDetails = [];
    Object.entries(serviceSelections).forEach(([id, config]) => {
      if (config.selected) {
        const serviceProfile = servicesData[id].profiles[config.profile];
        servicesDemand.cpu += serviceProfile.cpu;
        servicesDemand.ram += serviceProfile.ram;
        servicesDemand.storage += serviceProfile.storage;
        servicesDemand.gpu += serviceProfile.gpu || 0;
        selectedServicesDetails.push({
            name: servicesData[id].name,
            profileName: serviceProfile.name,
            ...serviceProfile
        });
      }
    });
    
    const deltas = {
        cpu: baseCapacity.cpu - servicesDemand.cpu,
        ram: baseCapacity.ram - servicesDemand.ram,
        storage: baseCapacity.storage - servicesDemand.storage,
        gpu: baseCapacity.gpu - servicesDemand.gpu,
    };

    return { baseCapacity, servicesDemand, deltas, selectedServicesDetails };
  }, [baseSelections, serviceSelections]);
  
  const activeNetworkRules = useMemo(() => {
    const rules = [networkData.rancher, networkData.clusterInternal];
    if (serviceSelections.suseSecurity.selected) rules.push(networkData.suseSecurity);
    if (serviceSelections.suseStorage.selected) rules.push(networkData.suseStorage);
    if (serviceSelections.privateRegistry.selected) rules.push(networkData.privateRegistry);
    if (serviceSelections.observability.selected) rules.push(networkData.observability);
    return rules;
  }, [serviceSelections]);

  const exportToPDF = () => {
    if (!pdfReady || !window.jspdf) {
        console.error("PDF generation library is not ready.");
        alert("PDF generation library is not ready. Please try again.");
        return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let finalY = 0;
    const pageMargin = 14;
    const pageWidth = doc.internal.pageSize.getWidth();
    const textWidth = pageWidth - (pageMargin * 2);

    // --- Page 1: Title & Intro ---
    doc.setFontSize(20);
    doc.text("SUSE AI Sizing Report", pageMargin, 22);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated on: ${new Date().toLocaleDateString()}`, pageMargin, 30);
    
    const introText = "SUSE AI is an open, secure, and enterprise-grade platform for deploying and managing generative AI and large language models. This application helps plan and estimate the hardware and network requirements for a SUSE AI deployment based on your selected components and services.";
    const splitIntro = doc.splitTextToSize(introText, textWidth);
    doc.setTextColor(0);
    doc.text(splitIntro, pageMargin, 38);
    
    doc.setFontSize(16);
    doc.text("Resource Summary", pageMargin, 55);
    doc.autoTable({
      startY: 60,
      head: [['Resource', 'Total Capacity', 'Services Demand', 'Remaining / Deficit']],
      body: [
        ['vCPUs', `${summary.baseCapacity.cpu}`, `${summary.servicesDemand.cpu}`, `${summary.deltas.cpu}`],
        ['RAM (GB)', `${summary.baseCapacity.ram}`, `${summary.servicesDemand.ram}`, `${summary.deltas.ram}`],
        ['Storage (GB)', `${summary.baseCapacity.storage}`, `${summary.servicesDemand.storage}`, `${summary.deltas.storage}`],
        ['GPUs', `${summary.baseCapacity.gpu}`, `${summary.servicesDemand.gpu}`, `${summary.deltas.gpu}`],
      ],
      theme: 'grid',
    });
    
    // --- Page 2: Configuration Details ---
    doc.addPage();
    doc.setFontSize(16);
    doc.text("Configuration Details", pageMargin, 22);
    
    const cpProfile = baseComponentData.controlPlane.profiles[baseSelections.controlPlane.profile];
    const gpuWnProfile = baseComponentData.gpuWorkerNodes.profiles[baseSelections.gpuWorkerNodes.profile];
    const genWnProfile = baseComponentData.generalWorkerNodes.profiles[baseSelections.generalWorkerNodes.profile];

    doc.setFontSize(14);
    doc.text("Base Cluster Configuration", pageMargin, 32);
    doc.autoTable({
        startY: 38,
        head: [['Component', 'Nodes', 'vCPU/Node', 'RAM/Node', 'Storage/Node']],
        body: [
            ['Control Plane', baseSelections.controlPlane.nodes, cpProfile.cpu, `${cpProfile.ram} GB`, `${cpProfile.storage} GB`],
            ['GPU Worker Nodes', baseSelections.gpuWorkerNodes.nodes, gpuWnProfile.cpu, `${gpuWnProfile.ram} GB`, `${gpuWnProfile.storage} GB`],
            ['General Purpose Workers', baseSelections.generalWorkerNodes.nodes, genWnProfile.cpu, `${genWnProfile.ram} GB`, `${genWnProfile.storage} GB`],
        ],
        theme: 'grid'
    });
    finalY = doc.lastAutoTable.finalY + 15;

    if(summary.selectedServicesDetails.length > 0) {
        doc.setFontSize(14);
        doc.text("Selected Services Configuration", pageMargin, finalY);
        doc.autoTable({
            startY: finalY + 8,
            head: [['Service', 'Profile', 'vCPUs', 'RAM', 'Storage', 'GPUs']],
            body: summary.selectedServicesDetails.map(s => [
                s.name, s.profileName, s.cpu, `${s.ram} GB`, `${s.storage} GB`, s.gpu || 0
            ]),
            theme: 'grid'
        });
    }

    // --- Page 3: Network Requirements ---
    if (activeNetworkRules.length > 0) {
        doc.addPage();
        doc.setFontSize(16);
        doc.text("Network & Firewall Requirements", pageMargin, 22);
        let tableStartY = 30;
        activeNetworkRules.forEach(rule => {
          doc.setFontSize(14);
          doc.text(rule.name, pageMargin, tableStartY);
          tableStartY += 8;
          doc.autoTable({
            startY: tableStartY,
            head: [['Port(s) & Protocol', 'Service/Purpose', 'Source', 'Destination']],
            body: rule.ports.map(p => [p.port, p.service, p.source, p.destination]),
            theme: 'grid'
          });
          tableStartY = doc.lastAutoTable.finalY + 15;
        });
    }
    
    // --- Disclaimer Page ---
    doc.addPage();
    doc.setFontSize(16);
    doc.text("Disclaimer & Official Documentation", pageMargin, 22);
    doc.setFontSize(10);
    const disclaimerText = "This report is for planning and estimation purposes only. All configurations should be verified against the latest official SUSE documentation before deployment. The resource requirements listed are based on available documentation and may not account for all specific workload characteristics or future updates.";
    const splitDisclaimer = doc.splitTextToSize(disclaimerText, textWidth);
    doc.text(splitDisclaimer, pageMargin, 32);
    finalY = 32 + (splitDisclaimer.length * 5);
    
    doc.setTextColor(60, 108, 208);
    doc.textWithLink('SUSE AI 1.0 Requirements', pageMargin, finalY + 10, { url: 'https://documentation.suse.com/suse-ai/1.0/html/AI-requirements/index.html' });
    doc.textWithLink('SUSE AI 1.0 Deployment Guide', pageMargin, finalY + 18, { url: 'https://documentation.suse.com/suse-ai/1.0/html/AI-deployment-intro/index.html' });
    doc.textWithLink('SUSE Application Collection', pageMargin, finalY + 26, { url: 'https://apps.rancher.com' });

    doc.save('SUSE_AI_Sizing_Report.pdf');
  };

  const TabButton = ({ id, label }) => (
    <button onClick={() => setActiveTab(id)} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors duration-200 ${activeTab === id ? 'bg-emerald-600 text-white shadow' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}>
      {label}
    </button>
  );

  return (
    <div className="bg-gray-50 min-h-screen font-sans text-gray-800">
      <div className="container mx-auto p-4 sm:p-6 lg:p-8">
        <header className="mb-8">
          <h1 className="text-4xl font-bold text-gray-800">SUSE AI Sizing Application</h1>
        </header>

        <div className="flex flex-wrap gap-2 border-b border-gray-300 mb-6 pb-2">
          <TabButton id="sizing" label="1. Cluster Sizing" />
          <TabButton id="diagram" label="2. Architecture Diagram" />
          <TabButton id="network" label="3. Network Requirements" />
          <TabButton id="summary" label="4. Summary & Export" />
        </div>

        <main className="bg-white p-6 rounded-xl shadow-lg">
          {activeTab === 'sizing' && <SizingTab baseSelections={baseSelections} serviceSelections={serviceSelections} onBaseChange={handleBaseChange} onServiceChange={handleServiceChange} summary={summary} />}
          {activeTab === 'diagram' && <ArchitectureDiagramTab baseSelections={baseSelections} serviceSelections={serviceSelections} />}
          {activeTab === 'network' && <NetworkTab activeRules={activeNetworkRules} />}
          {activeTab === 'summary' && <SummaryTab summary={summary} onExport={exportToPDF} pdfReady={pdfReady} />}
        </main>
        
        <footer className="text-center mt-10 text-sm text-gray-500">
            <p>This tool is for planning purposes only. Always refer to the latest official SUSE documentation for production deployments.</p>
        </footer>
      </div>
    </div>
  );
}

// --- Sizing Tab ---
const SizingTab = ({ baseSelections, serviceSelections, onBaseChange, onServiceChange, summary }) => {
    const gpuDemand = summary.servicesDemand.gpu;
    const gpuDelta = summary.deltas.gpu;

    return (
      <div className="space-y-8">
        <section className="p-4 bg-blue-50 rounded-lg border border-blue-200 text-blue-800">
            <h2 className="text-xl font-bold mb-2">Welcome to the SUSE AI Sizing Application</h2>
            <p className="text-sm">SUSE AI is an open, secure, and enterprise-grade platform for deploying and managing generative AI and large language models. This application helps you plan and estimate the hardware and network requirements for a SUSE AI deployment based on your selected components and services.</p>
        </section>
        <section>
          <h2 className="text-2xl font-semibold mb-4 text-gray-700">Base Cluster Configuration</h2>
          <div className="space-y-6">
            <BaseNodeCard id="controlPlane" data={baseComponentData.controlPlane} selection={baseSelections.controlPlane} onChange={onBaseChange} />
            <BaseNodeCard id="gpuWorkerNodes" data={baseComponentData.gpuWorkerNodes} selection={baseSelections.gpuWorkerNodes} onChange={onBaseChange} gpuDemand={gpuDemand} gpuDelta={gpuDelta} />
            <BaseNodeCard id="generalWorkerNodes" data={baseComponentData.generalWorkerNodes} selection={baseSelections.generalWorkerNodes} onChange={onBaseChange} />
          </div>
        </section>
        <section>
          <h2 className="text-2xl font-semibold mb-4 text-gray-700">Additional Services</h2>
          <div className="p-3 bg-sky-100 text-sky-900 rounded-md flex items-start text-sm mb-4">
              <Info size={20} className="mr-3 mt-0.5 flex-shrink-0"/>
              <div>These are just some of the services available. For a complete list, visit the 
                <a href="https://apps.rancher.com" target="_blank" rel="noopener noreferrer" className="font-bold underline ml-1 hover:text-sky-700">SUSE Application Collection</a>.
              </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Object.entries(servicesData).map(([id, data]) => (
              <ServiceCard key={id} id={id} data={data} selection={serviceSelections[id]} onChange={onServiceChange} />
            ))}
          </div>
        </section>
      </div>
    );
}

const BaseNodeCard = ({ id, data, selection, onChange, gpuDemand, gpuDelta }) => {
    const profile = data.profiles[selection.profile];
    return (
        <div className="border rounded-lg p-5 bg-gray-50 border-gray-200 space-y-4">
            <h3 className="text-xl font-bold text-gray-800">{data.name}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Object.keys(data.profiles).length > 1 && (
                    <div>
                        <label className="block text-sm font-medium text-gray-600 mb-1">Sizing Profile</label>
                        <select value={selection.profile} onChange={(e) => onChange(id, 'profile', e.target.value)} className="w-full p-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500">
                            {Object.entries(data.profiles).map(([pId, pData]) => <option key={pId} value={pId}>{pData.name}</option>)}
                        </select>
                    </div>
                )}
                <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">Number of Nodes</label>
                    <input type="number" min="1" value={selection.nodes} onChange={(e) => onChange(id, 'nodes', parseInt(e.target.value, 10) || 1)} className="w-full p-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500" />
                </div>
            </div>
            <div className="p-3 bg-blue-100 rounded-md text-blue-900">
                <h4 className="font-semibold mb-2">Resources (per node)</h4>
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                    <div className="flex items-center"><Cpu size={16} className="mr-2"/>{profile.cpu} vCPUs</div>
                    <div className="flex items-center"><MemoryStick size={16} className="mr-2"/>{profile.ram} GB RAM</div>
                    <div className="flex items-center"><HardDrive size={16} className="mr-2"/>{profile.storage} GB Storage</div>
                </div>
            </div>
            {id === 'controlPlane' && (
                <>
                <div className="p-3 bg-sky-100 text-sky-900 rounded-md flex items-start text-sm">
                    <Info size={20} className="mr-3 mt-0.5 flex-shrink-0"/>
                    <div>A minimum of 3 nodes is required for etcd quorum and kube-api redundancy in a production High Availability (HA) cluster.</div>
                </div>
                {selection.nodes < 3 && (
                    <div className="p-3 bg-amber-100 text-amber-900 rounded-md flex items-start text-sm">
                        <AlertTriangle size={20} className="mr-3 mt-0.5 flex-shrink-0"/>
                        <div>A non-HA setup with fewer than 3 nodes is not recommended for production environments due to the lack of fault tolerance.</div>
                    </div>
                )}
                </>
            )}
            {id === 'gpuWorkerNodes' && (
                <>
                <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">Total GPUs in Cluster</label>
                    <input type="number" min="0" value={selection.gpus} onChange={(e) => onChange(id, 'gpus', parseInt(e.target.value, 10) || 0)} className="w-full p-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500" />
                </div>
                <div className={`p-3 rounded-md flex items-center text-sm ${gpuDelta >= 0 ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}>
                    {gpuDelta >= 0 ? <CheckCircle size={20} className="mr-3 flex-shrink-0 text-emerald-500"/> : <AlertTriangle size={20} className="mr-3 flex-shrink-0 text-amber-500"/>}
                    <div>
                        <strong>Minimum GPUs Required: {gpuDemand}.</strong>
                        {gpuDelta < 0 && ` You have a deficit of ${Math.abs(gpuDelta)} GPU(s).`}
                    </div>
                </div>
                </>
            )}
        </div>
    );
};

const ServiceCard = ({ id, data, selection, onChange }) => {
    const { selected, profile } = selection;
    const serviceProfile = data.profiles[profile];
    
    return (
      <div className={`border rounded-lg p-4 transition-all duration-200 ${selected ? 'border-emerald-500 bg-emerald-50 shadow-md' : 'border-gray-300 bg-white'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <input type="checkbox" checked={selected} onChange={(e) => onChange(id, 'selected', e.target.checked)} className="h-5 w-5 rounded border-gray-300 text-emerald-600 focus:ring-0" />
            <h4 className="text-lg font-bold ml-3 text-gray-800">{data.name}</h4>
          </div>
          {selected && <CheckCircle className="text-emerald-500" />}
        </div>
        
        {selected && (
          <div className="mt-4 pt-4 border-t border-emerald-200 space-y-3">
            <p className="text-sm text-gray-600">{data.description}</p>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">Service Profile</label>
              <select value={profile} onChange={(e) => onChange(id, 'profile', e.target.value)} className="w-full p-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500">
                {Object.entries(data.profiles).map(([pId, pData]) => <option key={pId} value={pId}>{pData.name}</option>)}
              </select>
            </div>
            <div className="p-3 bg-blue-50 rounded-md text-blue-900">
                <h4 className="font-semibold mb-2 text-sm">Profile Requirements</h4>
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
                    <div className="flex items-center"><Cpu size={14} className="mr-2"/>{serviceProfile.cpu} vCPUs</div>
                    <div className="flex items-center"><MemoryStick size={14} className="mr-2"/>{serviceProfile.ram} GB RAM</div>
                    <div className="flex items-center"><HardDrive size={14} className="mr-2"/>{serviceProfile.storage} GB Storage</div>
                    {serviceProfile.gpu && <div className="flex items-center"><Layers size={14} className="mr-2"/>{serviceProfile.gpu} GPU(s)</div>}
                </div>
            </div>
          </div>
        )}
      </div>
    );
};

// --- Architecture Diagram Tab ---
const ArchitectureDiagramTab = ({ baseSelections, serviceSelections }) => {
    const cpProfile = baseComponentData.controlPlane.profiles[baseSelections.controlPlane.profile];
    const gpuWnProfile = baseComponentData.gpuWorkerNodes.profiles[baseSelections.gpuWorkerNodes.profile];
    const genWnProfile = baseComponentData.generalWorkerNodes.profiles[baseSelections.generalWorkerNodes.profile];
    
    const cpNodes = Array.from({ length: baseSelections.controlPlane.nodes }, (_, i) => i);
    const gpuWnNodes = Array.from({ length: baseSelections.gpuWorkerNodes.nodes }, (_, i) => i);
    const genWnNodes = Array.from({ length: baseSelections.generalWorkerNodes.nodes }, (_, i) => i);

    const selectedServices = Object.entries(serviceSelections)
        .filter(([, config]) => config.selected)
        .map(([id]) => servicesData[id]);

    return (
        <div className="space-y-8 p-4 bg-slate-100 rounded-lg">
            <h2 className="text-2xl font-semibold text-center text-gray-700">Proposed Architecture</h2>
            
            <div className="mb-8">
                <h3 className="text-xl font-bold text-center text-gray-600 mb-4">Control Plane</h3>
                <div className="flex justify-center flex-wrap gap-6">
                    {cpNodes.map(i => (
                        <NodeCard key={`cp-${i}`} title={`Control Plane Node ${i + 1}`} profile={cpProfile} />
                    ))}
                </div>
            </div>

            <div className="w-full flex justify-center">
                <div className="border-l-2 border-slate-400 border-dashed h-12"></div>
            </div>

            <div>
                <h3 className="text-xl font-bold text-center text-gray-600 mb-4">Worker Plane</h3>
                <div className="relative border-2 border-dashed border-emerald-500 rounded-xl p-8 pt-12 bg-white space-y-8">
                    <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-white px-4 font-bold text-emerald-600">WORKER NODES & SERVICES</div>
                    
                    {selectedServices.length > 0 && (
                        <div className="p-4 bg-emerald-50 rounded-lg">
                            <h4 className="text-lg font-semibold text-center text-emerald-800 mb-3">Additional Services Running on Cluster</h4>
                            <div className="flex justify-center flex-wrap gap-4 text-emerald-900">
                                {selectedServices.map(s => (
                                    <div key={s.name} className="flex items-center bg-emerald-200 rounded-full px-3 py-1 text-sm">
                                        {s.icon} {s.name}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <div className="space-y-4">
                            <h4 className="text-lg font-semibold text-center text-slate-700">GPU-Enabled Workers</h4>
                             <div className="text-center">
                                <div className="inline-flex items-center bg-slate-200 rounded-full px-4 py-2">
                                    <Layers className="w-6 h-6 mr-3 text-slate-600" />
                                    <span className="font-bold text-slate-800 text-lg">{baseSelections.gpuWorkerNodes.gpus} Total GPUs</span>
                                </div>
                            </div>
                            <div className="flex justify-center flex-wrap gap-6">
                                {gpuWnNodes.map(i => (
                                    <NodeCard key={`gpu-wn-${i}`} title={`GPU Worker ${i + 1}`} profile={gpuWnProfile} />
                                ))}
                            </div>
                        </div>
                         <div className="space-y-4">
                            <h4 className="text-lg font-semibold text-center text-slate-700">General Purpose Workers</h4>
                             <div className="flex justify-center flex-wrap gap-6">
                                {genWnNodes.map(i => (
                                    <NodeCard key={`gen-wn-${i}`} title={`GP Worker ${i + 1}`} profile={genWnProfile} />
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const NodeCard = ({ title, profile }) => (
    <div className="bg-white border border-slate-300 rounded-lg shadow-md w-64 flex-shrink-0">
        <div className="bg-slate-700 text-white font-bold p-3 rounded-t-lg flex items-center">
            <Server className="w-5 h-5 mr-2" />
            {title}
        </div>
        <div className="p-4 space-y-2 text-sm">
            <div className="flex items-center"><Cpu size={16} className="mr-3 text-slate-500"/>{profile.cpu} vCPUs</div>
            <div className="flex items-center"><MemoryStick size={16} className="mr-3 text-slate-500"/>{profile.ram} GB RAM</div>
            <div className="flex items-center"><HardDrive size={16} className="mr-3 text-slate-500"/>{profile.storage} GB Storage</div>
        </div>
    </div>
);


// --- Network Tab ---
const NetworkTab = ({ activeRules }) => (
    <div>
      <h2 className="text-2xl font-semibold mb-2 text-gray-700">Network & Firewall Rules</h2>
      <p className="text-gray-600 mb-6">Based on your selected components, the following network configurations are required.</p>
      <div className="space-y-8">
        {activeRules.map(rule => (
          <div key={rule.name} className="bg-gray-50 p-4 rounded-lg border border-gray-200">
            <h3 className="text-lg font-bold text-gray-800 mb-3">{rule.name}</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Port(s) & Protocol</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Service/Purpose</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Source</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Destination</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {rule.ports.map((p, i) => (
                    <tr key={i}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{p.port}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{p.service}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{p.source}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{p.destination}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
);

// --- Summary Tab ---
const SummaryTab = ({ summary, onExport, pdfReady }) => (
  <div>
    <div className="flex justify-between items-start mb-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-700">Deployment Summary</h2>
        <p className="text-gray-600">Review the total estimated resources for your configuration.</p>
      </div>
      <button onClick={onExport} disabled={!pdfReady} className="flex items-center bg-emerald-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-emerald-700 transition-colors shadow-md disabled:bg-gray-400 disabled:cursor-not-allowed">
        {pdfReady ? <FileDown size={20} className="mr-2" /> : <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>}
        {pdfReady ? 'Export to PDF' : 'Loading...'}
      </button>
    </div>

    <div className="space-y-6">
        <SummaryCard title="Total Cluster Capacity" data={summary.baseCapacity} />
        <SummaryCard title="Services Resource Demand" data={summary.servicesDemand} />
        <SummaryCard title="Remaining / Deficit Resources" data={summary.deltas} isDelta={true} />
    </div>
  </div>
);

const SummaryCard = ({ title, data, isDelta = false }) => {
    const getDeltaClass = (value) => value >= 0 ? 'text-emerald-600' : 'text-red-600';
    const getDeltaBgClass = (value) => value >= 0 ? 'bg-emerald-100' : 'bg-red-100';

    return (
        <div className={`rounded-xl p-5 border ${isDelta ? getDeltaBgClass(data.cpu) : 'bg-gray-100'}`}>
            <h3 className={`text-xl font-bold mb-4 ${isDelta && getDeltaClass(data.cpu)}`}>{title}</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="flex items-center">
                    <Cpu size={24} className={`mr-3 ${isDelta ? getDeltaClass(data.cpu) : 'text-emerald-600'}`} />
                    <div>
                        <div className={`text-sm ${isDelta ? '' : 'text-gray-600'}`}>vCPUs</div>
                        <div className={`text-2xl font-bold ${isDelta && getDeltaClass(data.cpu)}`}>{data.cpu}</div>
                    </div>
                </div>
                <div className="flex items-center">
                    <MemoryStick size={24} className={`mr-3 ${isDelta ? getDeltaClass(data.ram) : 'text-emerald-600'}`} />
                    <div>
                        <div className={`text-sm ${isDelta ? '' : 'text-gray-600'}`}>RAM (GB)</div>
                        <div className={`text-2xl font-bold ${isDelta && getDeltaClass(data.ram)}`}>{data.ram}</div>
                    </div>
                </div>
                <div className="flex items-center">
                    <HardDrive size={24} className={`mr-3 ${isDelta ? getDeltaClass(data.storage) : 'text-emerald-600'}`} />
                    <div>
                        <div className={`text-sm ${isDelta ? '' : 'text-gray-600'}`}>Storage (GB)</div>
                        <div className={`text-2xl font-bold ${isDelta && getDeltaClass(data.storage)}`}>{data.storage}</div>
                    </div>
                </div>
                 <div className="flex items-center">
                    <Layers size={24} className={`mr-3 ${isDelta ? getDeltaClass(data.gpu) : 'text-emerald-600'}`} />
                    <div>
                        <div className={`text-sm ${isDelta ? '' : 'text-gray-600'}`}>GPUs</div>
                        <div className={`text-2xl font-bold ${isDelta && getDeltaClass(data.gpu)}`}>{data.gpu}</div>
                    </div>
                </div>
            </div>
        </div>
    );
};
