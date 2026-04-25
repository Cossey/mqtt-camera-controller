import { findEventTypesInObj, getEventsXaddr, startPullPoint } from '../src/onvif/pullPoint';

const SOAP_CAPABILITIES_WITH_EVENTS_XADDR = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <s:Body>
    <tds:GetCapabilitiesResponse>
      <tds:Capabilities>
        <tds:Events>
          <tds:XAddr>http://192.168.50.202:1024/event-1024_1024</tds:XAddr>
        </tds:Events>
      </tds:Capabilities>
    </tds:GetCapabilitiesResponse>
  </s:Body>
</s:Envelope>`;

const SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa="http://www.w3.org/2005/08/addressing">
  <s:Body>
    <tev:CreatePullPointSubscriptionResponse>
      <wsnt:SubscriptionReference>
        <wsa:Address>http://192.168.50.202:1024/event-1024_1024/sub-1</wsa:Address>
      </wsnt:SubscriptionReference>
    </tev:CreatePullPointSubscriptionResponse>
  </s:Body>
</s:Envelope>`;

const SOAP_PULL_MESSAGES_OK = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tev="http://www.onvif.org/ver10/events/wsdl">
  <s:Body>
    <tev:PullMessagesResponse />
  </s:Body>
</s:Envelope>`;

function mockResponse(ok: boolean, status: number, body: string) {
  return {
    ok,
    status,
    text: async () => body,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('PullPoint event parsing', () => {
  test('maps CellMotionDetector topic to motion', () => {
    const obj = {
      'wsnt:NotificationMessage': {
        'wsnt:Topic': { _: 'tns1:RuleEngine/CellMotionDetector/Motion' },
        'wsnt:Message': {
          'tt:Message': {
            'tt:Data': {
              'tt:SimpleItem': { '@Name': 'IsMotion', '@Value': 'true' },
            },
          },
        },
      },
    };

    const res = findEventTypesInObj(obj);
    expect(res).toEqual([{ type: 'motion', state: true }]);
  });

  test('maps line crossing topic', () => {
    const obj = {
      'wsnt:NotificationMessage': {
        'wsnt:Topic': { _: 'tns1:RuleEngine/LineCrossDetector/LineCross' },
        'wsnt:Message': {
          'tt:Message': {
            'tt:Data': {
              'tt:SimpleItem': { '@Name': 'IsLineCross', '@Value': 'true' },
            },
          },
        },
      },
    };

    const res = findEventTypesInObj(obj);
    expect(res).toEqual([{ type: 'line', state: true }]);
  });

  test('maps TPLink smart event IsVehicle to vehicle', () => {
    const obj = {
      'wsnt:NotificationMessage': {
        'wsnt:Topic': { _: 'tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent' },
        'wsnt:Message': {
          'tt:Message': {
            'tt:Data': {
              'tt:SimpleItem': { '@Name': 'IsVehicle', '@Value': 'true' },
            },
          },
        },
      },
    };

    const res = findEventTypesInObj(obj);
    expect(res).toEqual([{ type: 'vehicle', state: true }]);
  });

  test('maps TPLink smart event IsPet to animal', () => {
    const obj = {
      'wsnt:NotificationMessage': {
        'wsnt:Topic': { _: 'tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent' },
        'wsnt:Message': {
          'tt:Message': {
            'tt:Data': {
              'tt:SimpleItem': { '@Name': 'IsPet', '@Value': 'false' },
            },
          },
        },
      },
    };

    const res = findEventTypesInObj(obj);
    expect(res).toEqual([{ type: 'animal', state: false }]);
  });

  test('ignores unrecognized topic mappings', () => {
    const obj = {
      'wsnt:NotificationMessage': {
        'wsnt:Topic': { _: 'tns1:RuleEngine/UnknownDetector/Unknown' },
        'wsnt:Message': {
          'tt:Message': {
            'tt:Data': {
              'tt:SimpleItem': { '@Name': 'State', '@Value': 'true' },
            },
          },
        },
      },
    };

    const res = findEventTypesInObj(obj);
    expect(res).toEqual([]);
  });

  test('auto endpointSelection (default) honors camera returned Events XAddr', async () => {
    const fetchMock = jest.fn(async () => mockResponse(true, 200, SOAP_CAPABILITIES_WITH_EVENTS_XADDR));
    const originalFetch = (globalThis as unknown as { fetch?: unknown }).fetch;
    (globalThis as unknown as { fetch?: unknown }).fetch = fetchMock;

    try {
      const xaddr = await getEventsXaddr({
        name: 'gate',
        host: '192.168.50.202',
        port: 2020,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://192.168.50.202:2020/onvif/device_service',
        expect.anything()
      );
      expect(xaddr).toBe('http://192.168.50.202:1024/event-1024_1024');
    } finally {
      (globalThis as unknown as { fetch?: unknown }).fetch = originalFetch;
    }
  });

  test('camera endpointSelection honors camera returned Events XAddr', async () => {
    const fetchMock = jest.fn(async () => mockResponse(true, 200, SOAP_CAPABILITIES_WITH_EVENTS_XADDR));
    const originalFetch = (globalThis as unknown as { fetch?: unknown }).fetch;
    (globalThis as unknown as { fetch?: unknown }).fetch = fetchMock;

    try {
      const xaddr = await getEventsXaddr({
        name: 'gate',
        host: '192.168.50.202',
        port: 2020,
        event: {
          mode: 'pull',
          pull: { endpointSelection: 'camera' },
        },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://192.168.50.202:2020/onvif/device_service',
        expect.anything()
      );
      expect(xaddr).toBe('http://192.168.50.202:1024/event-1024_1024');
    } finally {
      (globalThis as unknown as { fetch?: unknown }).fetch = originalFetch;
    }
  });

  test('configured endpointSelection pins Events XAddr to configured camera host/port', async () => {
    const fetchMock = jest.fn(async () => mockResponse(true, 200, SOAP_CAPABILITIES_WITH_EVENTS_XADDR));
    const originalFetch = (globalThis as unknown as { fetch?: unknown }).fetch;
    (globalThis as unknown as { fetch?: unknown }).fetch = fetchMock;

    try {
      const xaddr = await getEventsXaddr({
        name: 'gate',
        host: '192.168.50.202',
        port: 2020,
        event: {
          mode: 'pull',
          pull: { endpointSelection: 'configured' },
        },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://192.168.50.202:2020/onvif/device_service',
        expect.anything()
      );
      expect(xaddr).toBe('http://192.168.50.202:2020/event-1024_1024');
    } finally {
      (globalThis as unknown as { fetch?: unknown }).fetch = originalFetch;
    }
  });

  test('auto endpointSelection falls back to configured endpoint when camera endpoint fails', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/onvif/device_service')) {
        return mockResponse(true, 200, SOAP_CAPABILITIES_WITH_EVENTS_XADDR);
      }

      if (url.includes(':1024/')) {
        throw new Error('connect ECONNREFUSED 192.168.50.202:1024');
      }

      if (url.includes(':2020/event-1024_1024') && !url.includes('/sub-1')) {
        return mockResponse(true, 200, SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS);
      }

      if (url.includes(':2020/event-1024_1024/sub-1')) {
        return mockResponse(true, 200, SOAP_PULL_MESSAGES_OK);
      }

      return mockResponse(false, 500, 'unexpected url');
    });

    const originalFetch = (globalThis as unknown as { fetch?: unknown }).fetch;
    (globalThis as unknown as { fetch?: unknown }).fetch = fetchMock;
    const onHealthy = jest.fn();

    try {
      const controller = await startPullPoint(
        {
          name: 'gate',
          host: '192.168.50.202',
          port: 2020,
          event: {
            mode: 'pull',
            pull: { endpointSelection: 'auto' },
          },
        },
        () => undefined,
        {
          onHealthy,
          pollIntervalMs: 50,
        }
      );

      await wait(160);
      controller.stop();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(':1024/event-1024_1024'),
        expect.anything()
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(':2020/event-1024_1024'),
        expect.anything()
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(':2020/event-1024_1024/sub-1'),
        expect.anything()
      );
      expect(onHealthy).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as unknown as { fetch?: unknown }).fetch = originalFetch;
    }
  });

  test('reports unhealthy when pull polling fails after being healthy', async () => {
    let callIndex = 0;
    const fetchMock = jest.fn(async () => {
      callIndex += 1;
      if (callIndex === 1) return mockResponse(true, 200, SOAP_CAPABILITIES_WITH_EVENTS_XADDR);
      if (callIndex === 2) return mockResponse(true, 200, SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS);
      if (callIndex === 3) return mockResponse(true, 200, SOAP_PULL_MESSAGES_OK);
      return mockResponse(false, 500, 'pull failed');
    });

    const originalFetch = (globalThis as unknown as { fetch?: unknown }).fetch;
    (globalThis as unknown as { fetch?: unknown }).fetch = fetchMock;

    const onHealthy = jest.fn();
    const onError = jest.fn();

    try {
      const controller = await startPullPoint(
        {
          name: 'gate',
          host: '192.168.50.202',
          port: 2020,
        },
        () => undefined,
        {
          onHealthy,
          onError,
          pollIntervalMs: 50,
        }
      );

      await wait(220);
      controller.stop();

      expect(onHealthy).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as unknown as { fetch?: unknown }).fetch = originalFetch;
    }
  });
});