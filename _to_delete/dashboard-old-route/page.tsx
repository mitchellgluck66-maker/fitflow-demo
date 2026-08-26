'use client';

import React, { useState, useEffect } from 'react';
import { Card, Button, Badge, KPITile, Loader, Toast } from '@/components';
import { spacing, typography, colors } from '@/lib/design-tokens';
import clsx from 'clsx';

interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  stage: string;
  source: string;
  appointmentTime: string;
  estimatedValue: number;
  owner: string;
}

const STAGES = [
  'Applied',
  'Consult Booked',
  'Consult No Show',
  'Pre-Roadmap Booked',
  'Roadmap No Show',
  'Roadmap Completed: Objection',
  'Enrolled',
];

const STAGE_COLORS = {
  'Applied': 'info',
  'Consult Booked': 'primary',
  'Consult No Show': 'warning',
  'Pre-Roadmap Booked': 'primary',
  'Roadmap No Show': 'warning',
  'Roadmap Completed: Objection': 'danger',
  'Enrolled': 'success',
} as const;

export default function ActionQueueDashboard() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedStage, setSelectedStage] = useState<string | null>('Consult Booked');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Fetch leads from database
  useEffect(() => {
    const fetchLeads = async () => {
      try {
        const response = await fetch('/api/leads');
        const data = await response.json();
        setLeads(data);
      } catch (error) {
        console.error('Failed to fetch leads:', error);
        setToast({ message: 'Failed to load leads', type: 'error' });
      } finally {
        setLoading(false);
      }
    };

    fetchLeads();
  }, []);

  // Filter leads by selected stage
  const filteredLeads = selectedStage
    ? leads.filter(lead => lead.stage === selectedStage)
    : leads;

  // Calculate stats
  const stats = {
    totalLeads: leads.length,
    totalPipeline: leads.reduce((sum, lead) => sum + lead.estimatedValue, 0),
    enrolledThisWeek: leads.filter(lead => lead.stage === 'Enrolled').length,
    noShowRate: leads.length > 0
      ? Math.round(
          (leads.filter(lead => lead.stage === 'Consult No Show').length / leads.length) * 100
        )
      : 0,
  };

  const handleActionClick = (leadId: string, action: string) => {
    setToast({
      message: `Lead updated: ${action}`,
      type: 'success',
    });
    // TODO: Implement API call to update lead status
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader size="lg" variant="spinner" />
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: colors.bg.lightAlt }}>
      {/* Header */}
      <header className="bg-white/50 backdrop-blur-lg border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <h1
            className="text-3xl font-bold text-gray-900"
            style={{
              fontSize: typography.fontSize['3xl'].size,
              fontWeight: typography.fontWeight.bold,
            }}
          >
            Action Queue Dashboard
          </h1>
          <p className="text-gray-600 mt-2">Manage and track sales pipeline</p>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* KPI Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <KPITile
            label="Total Leads"
            value={stats.totalLeads}
            subtext="All stages"
          />
          <KPITile
            label="Pipeline Value"
            value={`$${(stats.totalPipeline / 1000).toFixed(0)}k`}
            subtext="Estimated"
            trend="up"
            trendValue="$12k"
          />
          <KPITile
            label="Enrolled"
            value={stats.enrolledThisWeek}
            subtext="This week"
            trend="up"
            trendValue="2 more"
          />
          <KPITile
            label="No-Show Rate"
            value={`${stats.noShowRate}%`}
            subtext="This month"
            trend="down"
            trendValue="3% less"
          />
        </div>

        {/* Stage Selector */}
        <Card className="mb-8">
          <div>
            <h2
              className="text-lg font-semibold text-gray-900 mb-4"
              style={{
                fontSize: typography.fontSize.lg.size,
                fontWeight: typography.fontWeight.semibold,
              }}
            >
              Filter by Stage
            </h2>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={selectedStage === null ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setSelectedStage(null)}
              >
                All ({leads.length})
              </Button>
              {STAGES.map(stage => {
                const count = leads.filter(lead => lead.stage === stage).length;
                return (
                  <Button
                    key={stage}
                    variant={selectedStage === stage ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => setSelectedStage(stage)}
                  >
                    {stage} ({count})
                  </Button>
                );
              })}
            </div>
          </div>
        </Card>

        {/* Leads Table */}
        <Card>
          <div>
            <h2
              className="text-lg font-semibold text-gray-900 mb-6"
              style={{
                fontSize: typography.fontSize.lg.size,
                fontWeight: typography.fontWeight.semibold,
              }}
            >
              {selectedStage ? `${selectedStage} (${filteredLeads.length})` : `All Leads (${filteredLeads.length})`}
            </h2>

            {filteredLeads.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-gray-500">No leads in this stage</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Name</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Email</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Stage</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Appointment</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Value</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Owner</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLeads.map(lead => (
                      <tr
                        key={lead.id}
                        className="border-b border-gray-200 hover:bg-gray-50 transition-colors"
                      >
                        <td className="py-4 px-4">
                          <div>
                            <p className="font-medium text-gray-900">
                              {lead.firstName} {lead.lastName}
                            </p>
                            <p className="text-sm text-gray-500">{lead.source}</p>
                          </div>
                        </td>
                        <td className="py-4 px-4 text-sm text-gray-600">{lead.email}</td>
                        <td className="py-4 px-4">
                          <Badge variant={STAGE_COLORS[lead.stage as keyof typeof STAGE_COLORS] || 'gray'}>
                            {lead.stage}
                          </Badge>
                        </td>
                        <td className="py-4 px-4 text-sm text-gray-600">
                          {formatDate(lead.appointmentTime)}
                        </td>
                        <td className="py-4 px-4 font-semibold text-gray-900">
                          ${lead.estimatedValue > 0 ? (lead.estimatedValue / 100).toLocaleString() : '—'}
                        </td>
                        <td className="py-4 px-4 text-sm text-gray-600">{lead.owner}</td>
                        <td className="py-4 px-4">
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => handleActionClick(lead.id, 'Attended')}
                            >
                              ✓
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => handleActionClick(lead.id, 'No Show')}
                            >
                              ✕
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      </main>

      {/* Toast Notification */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          isVisible={!!toast}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
