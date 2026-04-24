import { findEventTypesInObj } from '../src/onvif/pullPoint';

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
});